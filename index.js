```javascript
const express = require("express");

const app = express();
app.use(express.json({ strict: true }));

const PORT = process.env.PORT || 10000;
const SAFE_MAX = Number.MAX_SAFE_INTEGER;

function invalidInput(res) {
  return res.status(400).json({ error: "INVALID_INPUT" });
}

function isPlainObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function parseInstant(x) {
  if (typeof x !== "string") return null;

  // YYYY-MM-DDTHH:mm:ss[.sss](Z|±HH:mm)
  const re =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

  if (!re.test(x)) return null;

  const ms = Date.parse(x);
  return Number.isFinite(ms) ? ms : null;
}

function isSafePositiveVersion(x) {
  if (typeof x !== "string") return false;
  if (!/^[1-9]\d*$/.test(x)) return false;

  const n = Number(x);
  return Number.isSafeInteger(n) && n > 0;
}

function isSafeNonNegativeInteger(x) {
  return (
    typeof x === "number" &&
    Number.isSafeInteger(x) &&
    x >= 0
  );
}

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function isUnitInterval(x) {
  return isFiniteNumber(x) && x >= 0 && x <= 1;
}

function addGate(gates, code) {
  if (!gates.includes(code)) gates.push(code);
}

function sortCodes(codes) {
  return [...new Set(codes)].sort();
}

function validatePolicy(policy) {
  if (!isPlainObject(policy)) return false;

  if (typeof policy.datasetDigest !== "string" || policy.datasetDigest.length === 0)
    return false;

  if (typeof policy.schemaDigest !== "string" || policy.schemaDigest.length === 0)
    return false;

  if (!isSafeNonNegativeInteger(policy.maxAgeSeconds))
    return false;

  if (!isUnitInterval(policy.accuracyFloor))
    return false;

  if (!isFiniteNumber(policy.maxLatencyMs) || policy.maxLatencyMs < 0)
    return false;

  if (!isSafeNonNegativeInteger(policy.maxSizeBytes))
    return false;

  if (!isUnitInterval(policy.minImprovement))
    return false;

  if (!isPlainObject(policy.requiredSlices))
    return false;

  for (const [name, floor] of Object.entries(policy.requiredSlices)) {
    if (!isUnitInterval(floor)) return false;
  }

  return true;
}

app.post("/promote", (req, res) => {
  try {
    const body = req.body;

    if (!isPlainObject(body)) {
      return invalidInput(res);
    }

    const {
      asOf,
      championVersion,
      policy,
      versions
    } = body;

    /*
     * Only these are HTTP-400 structural/input errors.
     */
    if (
      typeof asOf !== "string" ||
      typeof championVersion !== "string" ||
      !isPlainObject(policy) ||
      !Array.isArray(versions)
    ) {
      return invalidInput(res);
    }

    const asOfMs = parseInstant(asOf);

    if (asOfMs === null) {
      return invalidInput(res);
    }

    const policyValid = validatePolicy(policy);

    const failedGates = {};
    const seen = new Set();
    const uniqueVersions = [];

    /*
     * IMPORTANT:
     * Reject every duplicate/noncanonical occurrence before
     * constructing the lookup map.
     */
    for (const v of versions) {
      if (!isPlainObject(v) || typeof v.version !== "string") {
        continue;
      }

      const id = v.version;

      if (!isSafePositiveVersion(id)) {
        if (!failedGates[id]) failedGates[id] = [];
        addGate(failedGates[id], "INVALID_VERSION");
        continue;
      }

      if (seen.has(id)) {
        if (!failedGates[id]) failedGates[id] = [];
        addGate(failedGates[id], "DUPLICATE_VERSION");
        continue;
      }

      seen.add(id);
      uniqueVersions.push(v);
    }

    const eligible = [];

    for (const version of uniqueVersions) {
      const id = version.version;
      const gates = [];

      if (!policyValid) {
        addGate(gates, "INVALID_POLICY");
      }

      /*
       * Evaluation must be an object.
       */
      if (!isPlainObject(version.evaluation)) {
        addGate(gates, "MISSING_EVALUATION");
        failedGates[id] = sortCodes(gates);
        continue;
      }

      const ev = version.evaluation;

      /*
       * Timestamp validation.
       */
      const createdMs = parseInstant(ev.createdAt);

      if (createdMs === null) {
        addGate(gates, "INVALID_TIMESTAMP");
      } else {
        if (createdMs > asOfMs) {
          addGate(gates, "FUTURE_EVALUATION");
        }

        if (
          policyValid &&
          createdMs < asOfMs - policy.maxAgeSeconds * 1000
        ) {
          addGate(gates, "STALE_EVALUATION");
        }
      }

      /*
       * Artifact lineage.
       */
      if (
        typeof version.artifactDigest !== "string" ||
        version.artifactDigest !== ev.artifactDigest
      ) {
        addGate(gates, "ARTIFACT_MISMATCH");
      }

      /*
       * Dataset/schema lineage.
       */
      if (
        policyValid &&
        ev.datasetDigest !== policy.datasetDigest
      ) {
        addGate(gates, "DATASET_MISMATCH");
      }

      if (
        policyValid &&
        ev.schemaDigest !== policy.schemaDigest
      ) {
        addGate(gates, "SCHEMA_MISMATCH");
      }

      /*
       * Aggregate metrics.
       */
      const accuracy = ev.accuracy;
      const latency = ev.latencyMs;
      const size = ev.sizeBytes;

      const metricsFinite =
        isFiniteNumber(accuracy) &&
        isFiniteNumber(latency) &&
        isFiniteNumber(size);

      if (!metricsFinite) {
        addGate(gates, "NON_FINITE");
      } else {
        if (
          !isUnitInterval(accuracy) ||
          latency < 0 ||
          size < 0 ||
          !Number.isSafeInteger(size)
        ) {
          addGate(gates, "METRIC_RANGE");
        }

        if (policyValid) {
          if (
            isUnitInterval(accuracy) &&
            accuracy < policy.accuracyFloor
          ) {
            addGate(gates, "ACCURACY_FLOOR");
          }

          if (
            latency >= 0 &&
            latency > policy.maxLatencyMs
          ) {
            addGate(gates, "LATENCY_LIMIT");
          }

          if (
            size >= 0 &&
            Number.isSafeInteger(size) &&
            size > policy.maxSizeBytes
          ) {
            addGate(gates, "SIZE_LIMIT");
          }
        }
      }

      /*
       * Required slices.
       */
      if (policyValid) {
        const slices = isPlainObject(ev.slices)
          ? ev.slices
          : {};

        for (const [sliceName, floor] of Object.entries(
          policy.requiredSlices
        )) {
          if (!(sliceName in slices)) {
            addGate(
              gates,
              `MISSING_SLICE:${sliceName}`
            );
            continue;
          }

          const value = slices[sliceName];

          if (!isUnitInterval(value)) {
            addGate(
              gates,
              `SLICE_RANGE:${sliceName}`
            );
          } else if (value < floor) {
            addGate(
              gates,
              `SLICE_FLOOR:${sliceName}`
            );
          }
        }
      }

      const finalCodes = sortCodes(gates);

      if (finalCodes.length > 0) {
        failedGates[id] = finalCodes;
      } else {
        eligible.push(version);
      }
    }

    /*
     * Sort eligible versions deterministically:
     * accuracy DESC
     * latency ASC
     * size ASC
     * numeric version ASC
     */
    eligible.sort((a, b) => {
      const ea = a.evaluation;
      const eb = b.evaluation;

      if (eb.accuracy !== ea.accuracy) {
        return eb.accuracy - ea.accuracy;
      }

      if (ea.latencyMs !== eb.latencyMs) {
        return ea.latencyMs - eb.latencyMs;
      }

      if (ea.sizeBytes !== eb.sizeBytes) {
        return ea.sizeBytes - eb.sizeBytes;
      }

      return Number(a.version) - Number(b.version);
    });

    const eligibleVersions = eligible.map(v => v.version);

    /*
     * Find champion only among the canonical, unique entries.
     */
    const champion = uniqueVersions.find(
      v => v.version === championVersion
    );

    const championEligible =
      champion !== undefined &&
      eligibleVersions.includes(championVersion);

    /*
     * Invalid champion evidence blocks promotion.
     */
    if (!championEligible) {
      return res.json({
        action: "block",
        championVersion,
        selectedVersion: null,
        eligibleVersions,
        failedGates,
        aliasMutation: null,
        evidence: null
      });
    }

    /*
     * Winner is the first ranked eligible version.
     */
    const winner = eligible[0];

    /*
     * If champion is already the best eligible version,
     * retain it.
     */
    if (winner.version === championVersion) {
      return res.json({
        action: "retain",
        championVersion,
        selectedVersion: championVersion,
        eligibleVersions,
        failedGates,
        aliasMutation: null,
        evidence: champion.evaluation
      });
    }

    /*
     * Accuracy improvement rounded to exactly 12 decimals.
     */
    const rawImprovement =
      winner.evaluation.accuracy -
      champion.evaluation.accuracy;

    const improvement =
      Math.round((rawImprovement + Number.EPSILON) * 1e12) /
      1e12;

    if (improvement >= policy.minImprovement) {
      return res.json({
        action: "promote",
        championVersion,
        selectedVersion: winner.version,
        eligibleVersions,
        failedGates,
        aliasMutation: {
          alias: "champion",
          version: winner.version
        },
        evidence: winner.evaluation
      });
    }

    return res.json({
      action: "retain",
      championVersion,
      selectedVersion: championVersion,
      eligibleVersions,
      failedGates,
      aliasMutation: null,
      evidence: champion.evaluation
    });
  } catch (err) {
    /*
     * Never leak an Express HTML 500 page.
     * Unexpected malformed input is treated as INVALID_INPUT.
     */
    return res.status(400).json({ error: "INVALID_INPUT" });
  }
});

app.get("/", (req, res) => {
  res.json({ service: "mlflow-promotion-gate" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
```

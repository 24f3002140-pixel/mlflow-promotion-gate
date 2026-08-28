const express = require('express');
const app = express();
app.use(express.json());

function parseDate(isoString) {
  if (typeof isoString !== 'string') return null;
  const regex = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2})$/;
  if (!regex.test(isoString)) return null;
  const ms = Date.parse(isoString);
  return isNaN(ms) ? null : ms;
}

function isSafePositiveIntegerString(s) {
  if (typeof s !== 'string') return false;
  if (!/^(0|[1-9]\\d*)$/.test(s)) return false;
  if (s.length > 1 && s === '0') return false;
  const num = Number(s);
  return Number.isSafeInteger(num) && num > 0;
}

app.post('/promote', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: "INVALID_INPUT" });
  }

  const { asOf, championVersion, policy, versions } = body;

  if (!policy || !Array.isArray(versions) || typeof championVersion !== 'string') {
    return res.status(400).json({ error: "INVALID_INPUT" });
  }

  const asOfMs = parseDate(asOf);
  if (asOfMs === null) {
    return res.status(400).json({ error: "INVALID_INPUT" });
  }

  if (typeof policy.datasetDigest !== 'string' || !policy.datasetDigest ||
      typeof policy.schemaDigest !== 'string' || !policy.schemaDigest ||
      typeof policy.maxAgeSeconds !== 'number' || policy.maxAgeSeconds < 0 || !Number.isSafeInteger(policy.maxAgeSeconds) ||
      typeof policy.accuracyFloor !== 'number' || !Number.isFinite(policy.accuracyFloor) || policy.accuracyFloor < 0 || policy.accuracyFloor > 1 ||
      typeof policy.maxLatencyMs !== 'number' || !Number.isFinite(policy.maxLatencyMs) || policy.maxLatencyMs < 0 ||
      typeof policy.maxSizeBytes !== 'number' || policy.maxSizeBytes < 0 || !Number.isSafeInteger(policy.maxSizeBytes) ||
      typeof policy.minImprovement !== 'number' || !Number.isFinite(policy.minImprovement) || policy.minImprovement < 0 || policy.minImprovement > 1) {
    return res.status(400).json({ error: "INVALID_INPUT" });
  }

  const failedGates = {};
  const seenVersions = new Set();
  const validVersionsList = [];
  const eligibleVersions = [];
  let championNode = null;

  for (const v of versions) {
    if (!v || typeof v.version !== 'string') continue;
    const vId = v.version;

    if (!isSafePositiveIntegerString(vId)) {
      failedGates[vId] = ["INVALID_VERSION"];
      continue;
    }
    if (seenVersions.has(vId)) {
      if (!failedGates[vId]) failedGates[vId] = [];
      if (!failedGates[vId].includes("DUPLICATE_VERSION")) {
        failedGates[vId].push("DUPLICATE_VERSION");
      }
      continue;
    }
    seenVersions.add(vId);
    validVersionsList.push(v);
  }

  for (const v of validVersionsList) {
    const vId = v.version;
    const gates = [];

    if (!v.evaluation) {
      gates.push("MISSING_EVALUATION");
      failedGates[vId] = gates;
      continue;
    }

    const evalObj = v.evaluation;
    const evalCreatedMs = parseDate(evalObj.createdAt);

    if (evalCreatedMs === null) {
      gates.push("INVALID_TIMESTAMP");
    } else {
      if (evalCreatedMs > asOfMs) {
        gates.push("FUTURE_EVALUATION");
      }
      if (asOfMs - policy.maxAgeSeconds * 1000 > evalCreatedMs) {
        gates.push("STALE_EVALUATION");
      }
    }

    if (v.artifactDigest !== evalObj.artifactDigest) {
      gates.push("ARTIFACT_MISMATCH");
    }
    if (policy.datasetDigest !== evalObj.datasetDigest) {
      gates.push("DATASET_MISMATCH");
    }
    if (policy.schemaDigest !== evalObj.schemaDigest) {
      gates.push("SCHEMA_MISMATCH");
    }

    const acc = evalObj.accuracy;
    const lat = evalObj.latencyMs;
    const sz = evalObj.sizeBytes;

    if (typeof acc !== 'number' || typeof lat !== 'number' || typeof sz !== 'number') {
      gates.push("NON_FINITE");
    } else {
      if (!Number.isFinite(acc) || !Number.isFinite(lat) || !Number.isFinite(sz)) {
        gates.push("NON_FINITE");
      } else {
        if (acc < 0 || acc > 1) gates.push("METRIC_RANGE");
        if (lat < 0) gates.push("METRIC_RANGE");
        if (sz < 0 || !Number.isSafeInteger(sz)) gates.push("METRIC_RANGE");

        if (!(acc < 0 || acc > 1) && acc < policy.accuracyFloor) gates.push("ACCURACY_FLOOR");
        if (lat >= 0 && lat > policy.maxLatencyMs) gates.push("LATENCY_LIMIT");
        if ((sz >= 0 && Number.isSafeInteger(sz)) && sz > policy.maxSizeBytes) gates.push("SIZE_LIMIT");
      }
    }

    const policySlices = policy.requiredSlices || {};
    const evalSlices = evalObj.slices || {};

    for (const [sliceName, floorValue] of Object.entries(policySlices)) {
      if (typeof floorValue !== 'number' || !Number.isFinite(floorValue) || floorValue < 0 || floorValue > 1) {
        return res.status(400).json({ error: "INVALID_INPUT" });
      }

      if (!(sliceName in evalSlices)) {
        gates.push(`MISSING_SLICE:${sliceName}`);
      } else {
        const val = evalSlices[sliceName];
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) {
          gates.push(`SLICE_RANGE:${sliceName}`);
        } else if (val < floorValue) {
          gates.push(`SLICE_FLOOR:${sliceName}`);
        }
      }
    }

    if (gates.length > 0) {
      failedGates[vId] = Array.from(new Set(gates)).sort();
    } else {
      eligibleVersions.push(vId);
    }

    if (vId === championVersion) {
      championNode = v;
    }
  }

  for (const k in failedGates) {
    if (failedGates[k].length === 0) delete failedGates[k];
  }

  const isChampionEligible = eligibleVersions.includes(championVersion);

  if (!isChampionEligible) {
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

  const sortedEligibles = [...validVersionsList]
    .filter(v => eligibleVersions.includes(v.version))
    .sort((a, b) => {
      if (b.evaluation.accuracy !== a.evaluation.accuracy) {
        return b.evaluation.accuracy - a.evaluation.accuracy;
      }
      if (a.evaluation.latencyMs !== b.evaluation.latencyMs) {
        return a.evaluation.latencyMs - b.evaluation.latencyMs;
      }
      if (a.evaluation.sizeBytes !== b.evaluation.sizeBytes) {
        return a.evaluation.sizeBytes - b.evaluation.sizeBytes;
      }
      return Number(a.version) - Number(b.version);
    });

  const challengerNode = sortedEligibles[0];
  
  if (challengerNode.version === championVersion) {
    return res.json({
      action: "retain",
      championVersion,
      selectedVersion: championVersion,
      eligibleVersions,
      failedGates,
      aliasMutation: null,
      evidence: championNode.evaluation
    });
  }

  const rawDiff = challengerNode.evaluation.accuracy - championNode.evaluation.accuracy;
  const roundedDiff = Math.round(rawDiff * 1e12) / 1e12;

  if (roundedDiff >= policy.minImprovement) {
    return res.json({
      action: "promote",
      championVersion,
      selectedVersion: challengerNode.version,
      eligibleVersions,
      failedGates,
      aliasMutation: {
        alias: "champion",
        version: challengerNode.version
      },
      evidence: challengerNode.evaluation
    });
  } else {
    return res.json({
      action: "retain",
      championVersion,
      selectedVersion: championVersion,
      eligibleVersions,
      failedGates,
      aliasMutation: null,
      evidence: championNode.evaluation
    });
  }
});

app.use((req, res) => res.status(404).json({ error: "NOT_FOUND" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

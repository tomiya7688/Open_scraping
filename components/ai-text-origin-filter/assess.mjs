import { createHash } from "node:crypto";

export const COMPONENT_VERSION = "0.1.0";
const MAX_TEXT_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(name + " must be an object");
  }
  return value;
}

function allowKeys(value, allowed, name) {
  const obj = object(value, name);
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new TypeError(name + " contains unsupported fields");
  }
  return obj;
}

function option(value, allowed, name) {
  if (!allowed.includes(value)) throw new TypeError("Invalid " + name);
  return value;
}

function labelInput(labels, digest) {
  if (labels === undefined) return [];
  if (!Array.isArray(labels) || labels.length > 32) {
    throw new TypeError("manual_labels must contain at most 32 labels");
  }

  return labels.map((entry) => {
    const label = allowKeys(entry, ["sha256", "origin"], "manual_label");
    if (typeof label.sha256 !== "string" || !SHA256.test(label.sha256)) {
      throw new TypeError("manual_label must include SHA-256");
    }
    option(label.origin, ["ai_generated", "human_written", "mixed"], "manual_label origin");
    return { sha256: label.sha256, origin: label.origin };
  }).filter((label) => label.sha256 === digest);
}

function disclosureInput(claim) {
  if (claim === undefined) return [];
  if (!Array.isArray(claim) || claim.length > 16) {
    throw new TypeError("source_claims must contain at most 16 claims");
  }
  return claim.map((entry) => {
    const value = allowKeys(entry, ["origin", "kind"], "source_claim");
    option(value.origin, ["ai_generated", "human_written", "mixed"], "source_claim origin");
    option(value.kind, ["author_disclosure", "page_metadata"], "source_claim kind");
    return { origin: value.origin, kind: value.kind };
  });
}

function detectorInput(value) {
  if (value === undefined) return undefined;
  const detector = allowKeys(value,
    ["score", "threshold", "model_id", "model_version", "language", "evaluation_ref"],
    "detector");
  if (typeof detector.score !== "number" || !Number.isFinite(detector.score) ||
      detector.score < 0 || detector.score > 1) {
    throw new TypeError("detector score must be a number between 0 and 1");
  }
  if (typeof detector.threshold !== "number" ||
      !Number.isFinite(detector.threshold) ||
      detector.threshold <= 0 || detector.threshold > 1) {
    throw new TypeError("detector threshold must be in (0, 1]");
  }
  for (const key of ["model_id", "model_version", "language"]) {
    if (typeof detector[key] !== "string" ||
        detector[key].length < 1 || detector[key].length > 128) {
      throw new TypeError("Invalid detector metadata");
    }
  }
  if (detector.evaluation_ref !== undefined &&
      (typeof detector.evaluation_ref !== "string" ||
       detector.evaluation_ref.length > 256)) {
    throw new TypeError("Invalid detector evaluation reference");
  }
  return detector;
}

function policyInput(value) {
  if (value === undefined) return {
    unknown_action: "review",
    source_disclosure_action: "review"
  };
  const policy = allowKeys(value,
    ["unknown_action", "source_disclosure_action"], "policy");
  return {
    unknown_action: option(policy.unknown_action ?? "review",
      ["review", "keep"], "unknown_action"),
    source_disclosure_action: option(policy.source_disclosure_action ?? "review",
      ["review", "exclude"], "source_disclosure_action")
  };
}

/**
 * Origin assessment, NOT a text-only AI detector.
 *
 * Caller-supplied manual labels are selection choices, not signed proof of
 * authorship. Site disclosures are unverified claims. External classifier
 * scores only suggest human review; they never auto-exclude in v0.1.
 *
 * Raw input text is never emitted in the result.
 */
export function assessTextOrigin(inputs) {
  const data = allowKeys(inputs,
    ["text", "manual_labels", "source_claims", "detector", "policy"], "inputs");
  if (typeof data.text !== "string" ||
      Buffer.byteLength(data.text, "utf8") > MAX_TEXT_BYTES) {
    throw new TypeError("text must be a UTF-8 string within the input limit");
  }
  const digest = createHash("sha256").update(data.text, "utf8").digest("hex");
  const labels = labelInput(data.manual_labels, digest);
  const claims = disclosureInput(data.source_claims);
  const detector = detectorInput(data.detector);
  const policy = policyInput(data.policy);

  const origins = new Set(labels.map((x) => x.origin));
  const claimsOrigin = new Set(claims.map((x) => x.origin));
  const reasons = [];
  let origin = "unknown";
  let decision = policy.unknown_action;

  if (origins.size > 1) {
    origin = "conflicted";
    decision = "review";
    reasons.push("CONFLICTING_MANUAL_LABELS");
  } else if (origins.has("ai_generated")) {
    origin = "user_labeled_ai";
    decision = "exclude";
    reasons.push("EXACT_HASH_USER_LABEL_AI");
  } else if (origins.has("human_written")) {
    origin = "user_labeled_human";
    decision = "keep";
    reasons.push("EXACT_HASH_USER_LABEL_HUMAN");
  } else if (origins.has("mixed")) {
    origin = "mixed";
    decision = "review";
    reasons.push("EXACT_HASH_USER_LABEL_MIXED");
  }

  // The webpage is not an authority for a user-selected manual label.
  // Contradictory disclosures are a review signal rather than a silent win.
  if (claimsOrigin.size > 1 ||
      (claimsOrigin.has("ai_generated") && origin === "user_labeled_human") ||
      (claimsOrigin.has("human_written") && origin === "user_labeled_ai")) {
    origin = "conflicted";
    decision = "review";
    reasons.push("CONFLICTING_ORIGIN_CLAIMS");
  } else if (origins.size === 0 && claimsOrigin.has("ai_generated")) {
    origin = "source_claimed_ai";
    decision = policy.source_disclosure_action;
    reasons.push("UNVERIFIED_SOURCE_AI_DISCLOSURE");
  } else if (origins.size === 0 && claimsOrigin.has("mixed")) {
    origin = "mixed";
    decision = "review";
    reasons.push("UNVERIFIED_SOURCE_MIXED_DISCLOSURE");
  } else if (origins.size === 0 && claimsOrigin.has("human_written")) {
    // A site's self-declaration is not a human-authorship certificate.
    reasons.push("UNVERIFIED_SOURCE_HUMAN_CLAIM");
  }

  if (detector !== undefined) {
    if (data.text.length < 200) {
      reasons.push("DETECTOR_SHORT_TEXT_UNRELIABLE");
    } else if (detector.score >= detector.threshold) {
      reasons.push("DETECTOR_HIGH_SCORE_NOT_PROOF");
      if (origin === "unknown") origin = "suspected_ai";
      // A classifier alone is never grounds for auto-exclusion.
      if (origins.size === 0 && !claimsOrigin.has("ai_generated")) {
        decision = "review";
      }
    } else {
      reasons.push("DETECTOR_NOT_CONCLUSIVE");
    }
  }

  if (reasons.length === 0) {
    reasons.push("NO_ORIGIN_EVIDENCE");
  }

  return {
    schema_version: "0.1",
    kind: "text-origin-assessment",
    component_version: COMPONENT_VERSION,
    text_sha256: digest,
    text_bytes: Buffer.byteLength(data.text, "utf8"),
    origin,
    decision,
    reasons,
    evidence: {
      matching_manual_labels: labels.length,
      source_claims: claims.map((claim) => ({ kind: claim.kind, origin: claim.origin })),
      ...(detector === undefined ? {} : {
        detector: {
          model_id: detector.model_id,
          model_version: detector.model_version,
          language: detector.language,
          score: detector.score,
          threshold: detector.threshold,
          // A claimed evaluation_ref is metadata, not a verified calibration.
          ...(detector.evaluation_ref === undefined
            ? {} : { evaluation_ref: detector.evaluation_ref })
        }
      })
    },
    disclaimer: "An assessment is not proof of human or AI authorship."
  };
}

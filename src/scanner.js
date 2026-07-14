/**
 * Secret scanner — shared between the CLI and the API.
 * Re-exported from the main app's scanner for consistency.
 */

const patterns = [
  { type: "AWS Access Key", severity: "critical", regex: /AKIA[0-9A-Z]{16}/g, mask: /(?<=AKIA).{8}/ },
  { type: "AWS Secret Key", severity: "critical", regex: /aws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi, mask: /.{12}$/ },
  { type: "GitHub PAT", severity: "high", regex: /ghp_[A-Za-z0-9]{36}/g, mask: /(?<=ghp_)[A-Za-z0-9]{20}/ },
  { type: "GitHub OAuth", severity: "high", regex: /gho_[A-Za-z0-9]{36}/g, mask: /(?<=gho_)[A-Za-z0-9]{20}/ },
  { type: "Private Key", severity: "critical", regex: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, mask: /-----BEGIN.*-----/ },
  { type: "Database URL", severity: "high", regex: /(postgres|postgresql|mysql|mongodb|redis):\/\/[^\s"']+:[^\s"']+@[^\s"']+/gi, mask: /:[^\s"']+@/ },
  { type: "JWT", severity: "medium", regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, mask: /\.[A-Za-z0-9_-]+$/ },
  { type: "Slack Token", severity: "high", regex: /xox[baprs]-[A-Za-z0-9-]+/g, mask: /(?<=xox.)[A-Za-z0-9-]{12}/ },
  { type: "Stripe Secret Key", severity: "critical", regex: /sk_live_[A-Za-z0-9]{24,}/g, mask: /(?<=sk_live_)[A-Za-z0-9]{12}/ },
  { type: "Google API Key", severity: "high", regex: /AIza[0-9A-Za-z_-]{35}/g, mask: /(?<=AIza)[0-9A-Za-z_-]{20}/ },
  { type: "Generic API Key", severity: "medium", regex: /(?:api[_-]?key|apikey|secret[_-]?key)\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}["']?/gi, mask: /[A-Za-z0-9_-]{12}$/ },
];

function maskValue(match, maskPattern) {
  return match.replace(maskPattern, "****");
}

function scanContentForSecrets(content) {
  const detections = [];
  for (const p of patterns) {
    const matches = content.matchAll(p.regex);
    for (const m of matches) {
      const matchStr = m[0];
      const preview = maskValue(matchStr, p.mask);
      detections.push({
        type: p.type,
        preview: preview.length > 40 ? preview.slice(0, 37) + "..." : preview,
        severity: p.severity,
        match: matchStr,
      });
    }
  }
  return detections;
}

module.exports = { scanContentForSecrets };

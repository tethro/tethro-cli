/**
 * License scanner — shared between the CLI and the API.
 */

const licensePatterns = [
  { type: "GPL-3.0", riskLevel: "block", patterns: [/GNU General Public License v3/i, /GPL-3\.0/i, /GPLv3/i, /This program is free software.*you can redistribute it and\/or modify/i] },
  { type: "AGPL-3.0", riskLevel: "block", patterns: [/GNU Affero General Public License v3/i, /AGPL-3\.0/i, /AGPLv3/i] },
  { type: "LGPL-3.0", riskLevel: "review", patterns: [/GNU Lesser General Public License/i, /LGPL-3\.0/i, /LGPLv3/i] },
  { type: "MPL-2.0", riskLevel: "review", patterns: [/Mozilla Public License.*2\.0/i, /MPL-2\.0/i, /MPL 2\.0/i] },
  { type: "CDDL-1.0", riskLevel: "block", patterns: [/Common Development and Distribution License/i, /CDDL-1\.0/i, /CDDL 1\.0/i] },
  { type: "EPL-2.0", riskLevel: "review", patterns: [/Eclipse Public License.*2\.0/i, /EPL-2\.0/i, /EPL 2\.0/i] },
  { type: "Unlicensed", riskLevel: "block", patterns: [/All rights reserved\.?\s*No license/i, /UNLICENSED/i, /Proprietary.*all rights reserved/i] },
  { type: "Apache-2.0", riskLevel: "notice", patterns: [/Apache License.*2\.0/i, /Apache-2\.0/i] },
  { type: "MIT", riskLevel: "notice", patterns: [/MIT License/i, /Permission is hereby granted, free of charge/i] },
  { type: "BSD-3-Clause", riskLevel: "notice", patterns: [/BSD 3-Clause/i, /Redistribution and use in source and binary forms/i] },
];

function scanContentForLicenses(content) {
  const detections = [];
  for (const lp of licensePatterns) {
    for (const pattern of lp.patterns) {
      const match = content.match(pattern);
      if (match) {
        const idx = match.index || 0;
        const start = Math.max(0, idx - 30);
        const end = Math.min(content.length, idx + match[0].length + 30);
        const snippet = content.slice(start, end).replace(/\n/g, " ").trim();
        detections.push({
          type: lp.type,
          riskLevel: lp.riskLevel,
          snippet: snippet.length > 100 ? snippet.slice(0, 97) + "..." : snippet,
        });
        break;
      }
    }
  }
  return detections;
}

module.exports = { scanContentForLicenses };

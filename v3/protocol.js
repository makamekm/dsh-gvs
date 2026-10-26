export const clip = (value, limit = 6000) => String(value ?? '').slice(0, limit);
export const compactEvidence = values => (values ?? []).slice(-8).map(value => ({
  ...value, command: clip(value.command, 1000), output: clip(value.output, 1200)
}));

export function recordAfter(text, marker) {
  const offset = String(text).lastIndexOf(marker);
  if (offset < 0) return null;
  const tail = String(text).slice(offset + marker.length).trimStart();
  if (tail[0] !== '{') return null;
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < tail.length; index++) {
    const character = tail[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) {
      try { return JSON.parse(tail.slice(0, index + 1)); } catch { return null; }
    }
  }
  return null;
}

export function technicalDecision(text, evidence = []) {
  const record = recordAfter(text, 'GVS_REVIEW_JSON:');
  if (!record || !['pass', 'fix', 'blocked'].includes(record.verdict) || !Array.isArray(record.checks)) {
    return { accepted: false, verified: false, reason: 'Technical review has no valid verdict.' };
  }
  const commands = [...new Set(record.checks.filter(command => typeof command === 'string' && command.trim()).map(command => command.trim()))];
  const verified = commands.length > 0 && commands.every(command => evidence.some(item =>
    item.command.trim() === command && !item.error && item.exitCode === 0 && item.finished));
  return { accepted: record.verdict === 'pass' && record.codeSimplicity === 'pass' && record.scopePreserved === true,
    verified, blocked: record.verdict === 'blocked', reason: clip(record.summary, 2500), checks: commands };
}

export function userDecision(text) {
  const record = recordAfter(text, 'GVS_USER_JSON:');
  if (!record || !['approve', 'revise', 'blocked'].includes(record.verdict) || !Array.isArray(record.mustFix)) {
    return { accepted: false, blocked: true, reason: 'The User agent did not provide a valid decision.', mustFix: [] };
  }
  return { ...record, accepted: record.verdict === 'approve' && record.mustFix.length === 0,
    blocked: record.verdict === 'blocked', reason: clip(record.summary, 2500) };
}

export function designDecision(text) {
  const record = recordAfter(text, 'GVS_DESIGN_JSON:');
  return { ...record, accepted: record?.verdict === 'pass' && Array.isArray(record.issues) && record.issues.length === 0,
    blocked: !record || record.verdict === 'blocked', reason: clip(record?.summary, 2500) };
}

export function visualDecision(state, design, user) {
  if (!state.brief?.visualRequired) return { verified: true, reason: 'This task has no visible interface.' };
  const current = state.visualChecks.filter(check => check.cycle === state.cycle && check.revision === state.revision && check.ok);
  const images = current.flatMap(check => check.images ?? []);
  const reviewed = decision => {
    const ids = new Set(decision.screenshotsReviewed ?? []);
    const received = new Set([...(decision.imagesReceived ?? []), ...current
      .filter(check => check.capturedBy === decision.childId).flatMap(check => check.images ?? []).map(image => image.attachment.attachmentId)]);
    return ['desktop', 'mobile'].every(viewport => images.some(image => image.viewport === viewport && ids.has(image.attachment.attachmentId) && received.has(image.attachment.attachmentId)));
  };
  const captureExists = ['desktop', 'mobile'].every(viewport => images.some(image => image.viewport === viewport));
  const interaction = !state.brief.interactionRequired || current.some(check => check.interactions > 0 && check.assertions > 0);
  return { verified: captureExists && interaction && reviewed(design) && reviewed(user),
    reason: !captureExists ? 'Fresh desktop and mobile screenshots are missing.' : !interaction ? 'The primary user journey has not been exercised with an assertion.' : !reviewed(design) || !reviewed(user) ? 'Designer and User must both review the actual desktop and mobile images.' : 'Rendered screens and user journey reviewed.' };
}

// Minimal R11/R12 reference model. This is not a schema, worker, or storage implementation.
const clone = (value) => structuredClone(value);
const layers = new Set(['base', 'rule-output', 'merged', 'overlay', 'runtime']);
const scopeFields = ['projectId', 'environmentId', 'configId', 'entryContextId'];
const requireText = (value, field) => {
  if (typeof value !== 'string' || !value) throw new Error(`missing ${field}`);
  return value;
};

export function factKey(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error('FactRef required');
  const fields = ['kind', 'id', 'revisionId', 'snapshotId', 'sourceViewId', 'layer'];
  for (const field of fields) requireText(ref[field], field);
  if (ref.kind === 'EntityRef' || !layers.has(ref.layer)) throw new Error('invalid fact kind/layer');
  const scope = scopeFields.map((field) => requireText(ref.scope?.[field], `scope.${field}`));
  return JSON.stringify([ref.kind, ref.id, ref.revisionId, ref.snapshotId, ref.sourceViewId, ref.layer, scope]);
}

export class FactStore {
  #facts = new Map();
  #derivations = new Map();

  addFact(record) {
    if ('derivationRefs' in record) throw new Error('support index is a query projection');
    const key = factKey(record.ref);
    const existing = this.#facts.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('same version changed');
    this.#facts.set(key, clone(record));
  }

  resolve(ref) {
    const record = this.#facts.get(factKey(ref));
    if (!record) throw new Error('missing exact fact');
    return clone(record);
  }

  addDerivation(derivation) {
    const key = factKey(derivation.ref);
    if (derivation.ref.kind !== 'Derivation') throw new Error('Derivation reference required');
    if (!Array.isArray(derivation.inputFactRefs) || !derivation.inputFactRefs.length) throw new Error('inputs required');
    if (!Array.isArray(derivation.outputFactRefs) || !derivation.outputFactRefs.length) throw new Error('outputs required');
    if ('inputFactIds' in derivation || 'outputIds' in derivation) throw new Error('ID-only dependency forbidden');
    const inputs = derivation.inputFactRefs.map((ref) => factKey(ref));
    const outputs = derivation.outputFactRefs.map((ref) => factKey(ref));
    const allowedViews = new Set(derivation.allowedInputViews ?? [derivation.ref.sourceViewId]);
    for (const ref of [...derivation.inputFactRefs, ...derivation.outputFactRefs]) {
      this.resolve(ref);
      if (ref.snapshotId !== derivation.ref.snapshotId) throw new Error('cross snapshot dependency');
      if (!allowedViews.has(ref.sourceViewId)) throw new Error('undeclared source view');
    }
    for (const ref of derivation.outputFactRefs) {
      if (ref.sourceViewId !== derivation.ref.sourceViewId) throw new Error('output source view mismatch');
    }
    if (derivation.ref.sourceViewId === 'static') {
      for (const ref of derivation.inputFactRefs) {
        if (ref.sourceViewId !== 'static' || this.resolve(ref).production !== 'automatic') throw new Error('auxiliary source in static');
      }
    }
    const existing = this.#derivations.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(derivation)) throw new Error('same derivation version changed');
    const graph = new Map();
    for (const item of [...this.#derivations.values(), derivation]) {
      for (const out of item.outputFactRefs) {
        const outKey = factKey(out);
        graph.set(outKey, [...(graph.get(outKey) ?? []), ...item.inputFactRefs.map(factKey)]);
      }
    }
    const reaches = (start, target, seen = new Set()) => {
      if (start === target) return true;
      if (seen.has(start)) return false;
      seen.add(start);
      return (graph.get(start) ?? []).some((next) => reaches(next, target, seen));
    };
    for (const output of outputs) {
      for (const input of inputs) {
        if (reaches(input, output)) throw new Error('self-support or cyclic dependency');
      }
    }
    this.#derivations.set(key, clone(derivation));
  }

  supports(outputRef) {
    const key = factKey(outputRef);
    return [...this.#derivations.values()]
      .filter((item) => item.outputFactRefs.some((ref) => factKey(ref) === key))
      .map(clone);
  }

  removeDerivation(ref) {
    this.#derivations.delete(factKey(ref));
  }
}

function slotKey(slot) {
  return JSON.stringify(['workspaceId', 'publicationScopeId', 'sourceViewId'].map((name) => requireText(slot?.[name], name)));
}

function validateSavedState(state) {
  const corrupt = () => { throw new Error('inconsistent saved publication state'); };
  for (const field of ['slots', 'requests', 'attempts', 'snapshots']) {
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) corrupt();
  }
  for (const [key, slot] of Object.entries(state.slots)) {
    if (!Number.isSafeInteger(slot.latestRequestedGeneration) || slot.latestRequestedGeneration < 0) corrupt();
    const requests = Object.values(state.requests).filter((request) => request.slotKey === key);
    const generations = requests.map((request) => request.requestGeneration);
    if (new Set(generations).size !== generations.length || Math.max(0, ...generations) !== slot.latestRequestedGeneration) corrupt();
    if (slot.currentSnapshotId !== null) {
      const snapshot = state.snapshots[slot.currentSnapshotId];
      const request = snapshot && state.requests[snapshot.requestId];
      if (!request || request.slotKey !== key || request.state !== 'open') corrupt();
      if (!Object.values(state.attempts).some((attempt) => attempt.snapshotId === slot.currentSnapshotId && attempt.requestId === snapshot.requestId && attempt.decision === 'sealed_completed' && attempt.publicationState === 'published')) corrupt();
    }
  }
  for (const [id, request] of Object.entries(state.requests)) {
    const slot = state.slots[request.slotKey];
    if (!slot || !Number.isSafeInteger(request.requestGeneration) || request.requestGeneration < 1 || request.requestGeneration > slot.latestRequestedGeneration) corrupt();
    if (!['open', 'failed', 'cancelled'].includes(request.state)) corrupt();
    if (request.activeAttemptId && state.attempts[request.activeAttemptId]?.requestId !== id) corrupt();
  }
  for (const [id, snapshot] of Object.entries(state.snapshots)) {
    const request = state.requests[snapshot.requestId];
    if (snapshot.snapshotId !== id || !request || snapshot.requestGeneration !== request.requestGeneration) corrupt();
    if (JSON.stringify(snapshot.frozen) !== JSON.stringify(request.frozen)) corrupt();
  }
  for (const attempt of Object.values(state.attempts)) {
    if (!state.requests[attempt.requestId] || !['open', 'sealed_completed', 'sealed_failed', 'sealed_cancelled'].includes(attempt.decision)) corrupt();
    if (!['staged', 'eligible', 'published', 'historical', 'isolated'].includes(attempt.publicationState)) corrupt();
    if (attempt.decision === 'sealed_completed' && state.snapshots[attempt.snapshotId]?.requestId !== attempt.requestId) corrupt();
  }
}

export class PublicationCoordinator {
  #state;

  constructor(saved = { slots: {}, requests: {}, attempts: {}, snapshots: {} }) {
    this.#state = clone(saved);
    validateSavedState(this.#state);
  }

  register(slot, requestId, frozen) {
    requireText(requestId, 'requestId');
    const key = slotKey(slot);
    const old = this.#state.requests[requestId];
    if (old) {
      if (old.slotKey !== key || JSON.stringify(old.frozen) !== JSON.stringify(frozen)) throw new Error('request identity reused');
      return old.requestGeneration;
    }
    const entry = this.#state.slots[key] ??= { latestRequestedGeneration: 0, currentSnapshotId: null };
    const requestGeneration = ++entry.latestRequestedGeneration;
    this.#state.requests[requestId] = { slotKey: key, requestGeneration, frozen: clone(frozen), state: 'open' };
    return requestGeneration;
  }

  start(requestId, attemptId) {
    const request = this.#request(requestId);
    requireText(attemptId, 'attemptId');
    if (request.state !== 'open') throw new Error('request terminal');
    if (this.#state.attempts[attemptId]) throw new Error('attempt identity reused');
    if (request.activeAttemptId && this.#attempt(request.activeAttemptId).decision !== 'sealed_failed') throw new Error('only failed attempt may retry');
    request.activeAttemptId = attemptId;
    this.#state.attempts[attemptId] = { requestId, decision: 'open', publicationState: 'staged' };
  }

  finish(attemptId, snapshotId, payload) {
    const attempt = this.#attempt(attemptId);
    if (attempt.decision !== 'open') throw new Error('attempt terminal');
    const request = this.#request(attempt.requestId);
    if (request.state !== 'open') throw new Error('request terminal');
    if (this.#state.snapshots[snapshotId]) throw new Error('snapshot identity reused');
    this.#state.snapshots[snapshotId] = { snapshotId, requestId: attempt.requestId, requestGeneration: request.requestGeneration, frozen: clone(request.frozen), payload: clone(payload) };
    attempt.snapshotId = snapshotId;
    attempt.decision = 'sealed_completed';
    attempt.publicationState = 'eligible';
  }

  cancel(requestId) {
    const request = this.#request(requestId);
    const attempts = Object.values(this.#state.attempts).filter((item) => item.requestId === requestId);
    if (attempts.some((item) => item.decision === 'sealed_completed')) return 'already_terminal';
    request.state = 'cancelled';
    for (const attempt of attempts) {
      if (attempt.decision === 'open') attempt.decision = 'sealed_cancelled';
      attempt.publicationState = 'isolated';
    }
    return 'accepted';
  }

  fail(requestId) {
    const request = this.#request(requestId);
    const attempts = Object.values(this.#state.attempts).filter((item) => item.requestId === requestId);
    if (request.state !== 'open' || attempts.some((item) => item.decision === 'sealed_completed')) return 'already_terminal';
    request.state = 'failed';
    for (const attempt of attempts) {
      if (attempt.decision === 'open') attempt.decision = 'sealed_failed';
      attempt.publicationState = 'isolated';
    }
    return 'accepted';
  }

  failAttempt(attemptId) {
    const attempt = this.#attempt(attemptId);
    if (attempt.decision !== 'open') throw new Error('attempt terminal');
    attempt.decision = 'sealed_failed';
    attempt.publicationState = 'isolated';
  }

  prepare(attemptId) {
    const attempt = this.#attempt(attemptId);
    if (attempt.decision !== 'sealed_completed' || attempt.publicationState !== 'eligible') throw new Error('not eligible');
    const request = this.#request(attempt.requestId);
    return { attemptId, snapshotId: attempt.snapshotId, requestGeneration: request.requestGeneration };
  }

  commit(ticket) {
    const attempt = this.#attempt(ticket.attemptId);
    const request = this.#request(attempt.requestId);
    const slot = this.#state.slots[request.slotKey];
    if (ticket.snapshotId !== attempt.snapshotId || ticket.requestGeneration !== request.requestGeneration) throw new Error('invalid ticket');
    if (attempt.publicationState === 'published') return 'already_published';
    if (attempt.decision !== 'sealed_completed' || attempt.publicationState !== 'eligible' || request.state !== 'open' || request.activeAttemptId !== ticket.attemptId) return 'ineligible';
    // This check and the pointer write form one indivisible transition in this in-memory model.
    if (request.requestGeneration !== slot.latestRequestedGeneration) {
      attempt.publicationState = 'historical';
      return 'superseded';
    }
    slot.currentSnapshotId = attempt.snapshotId;
    attempt.publicationState = 'published';
    return 'published';
  }

  current(slot) {
    const id = this.#state.slots[slotKey(slot)]?.currentSnapshotId;
    return id ? clone(this.#state.snapshots[id]) : null;
  }

  history(snapshotId) { return clone(this.#state.snapshots[snapshotId] ?? null); }
  attempt(attemptId) { return clone(this.#attempt(attemptId)); }
  exportState() { return clone(this.#state); }
  #request(id) { const value = this.#state.requests[id]; if (!value) throw new Error('unknown request'); return value; }
  #attempt(id) { const value = this.#state.attempts[id]; if (!value) throw new Error('unknown attempt'); return value; }
}

export interface DemandItem {
  orderItemId: number;
  partCode: string;
  length: number;
  remaining: number;
}

export interface CandidateBar {
  code: string;
  length: number;
  isRemnant: boolean;
}

export interface CutParams {
  kerf: number;
  endTrim: number;
  reusableThreshold: number;
  finalSeparationRule: "reusable_only" | "always";
}

export interface PlannedPiece {
  orderItemId: number;
  partCode: string;
  length: number;
}

export interface PlannedBar {
  barCode: string;
  barLength: number;
  isRemnant: boolean;
  pieces: PlannedPiece[];
  endTrim: number;
  cuts: number;
  remnantLength: number;
  nonReusableLoss: number;
  finalCutRequired: boolean;
}

export interface SolveResult {
  bars: PlannedBar[];
  exact: boolean;
  optimalityNote: string;
  lowerBoundNewBars: number;
  newBarsUsed: number;
  nonReusableLoss: number;
}

interface Bin {
  candidate: CandidateBar;
  pieces: PlannedPiece[];
  load: number;
}

const EXACT_LIMIT = 14;

export function validateDemand(demand: DemandItem[], params: CutParams, bars: CandidateBar[]) {
  const uncuttable = demand.filter((item) => {
    const required = params.endTrim + item.length;
    return !bars.some((bar) => bar.length >= required);
  }).map((item) => ({ partCode: item.partCode, length: item.length }));
  if (uncuttable.length) {
    const e = new Error("some parts are longer than every available matching bar");
    (e as Error & { code: string }).code = "NO_FEASIBLE_PATTERN";
    (e as Error & { details: unknown }).details = uncuttable;
    throw e;
  }
}

export function solveCutting(
  demandItems: DemandItem[],
  candidateBars: CandidateBar[],
  params: CutParams,
): SolveResult {
  validateDemand(demandItems, params, candidateBars);
  const units = demandItems
    .flatMap((item) => Array.from({ length: item.remaining }, () => item))
    .sort((a, b) => b.length - a.length || a.orderItemId - b.orderItemId)
    .map((item) => ({ orderItemId: item.orderItemId, partCode: item.partCode, length: item.length }));

  const bins = units.length <= EXACT_LIMIT && candidateBars.length <= 80
    ? exactPack(units, candidateBars, params)
    : heuristicPack(units, candidateBars, params);

  if (!bins) {
    const e = new Error("available matching bars cannot satisfy all remaining quantities");
    (e as Error & { code: string }).code = "NO_FEASIBLE_PATTERN";
    throw e;
  }

  const planned = bins.filter((bin) => bin.pieces.length > 0).map(finalizeBin);
  const totalLoad = units.reduce((sum, piece) => sum + piece.length + params.kerf, 0);
  const remnantCapacity = candidateBars
    .filter((bar) => bar.isRemnant)
    .reduce((sum, bar) => sum + Math.max(0, bar.length - params.endTrim + params.kerf), 0);
  const maxCapacity = Math.max(...candidateBars.map((bar) => bar.length - params.endTrim + params.kerf));
  const lowerBoundNewBars = Math.max(0, Math.ceil(Math.max(0, totalLoad - remnantCapacity) / maxCapacity));
  const newBarsUsed = planned.filter((bar) => !bar.isRemnant).length;
  const nonReusableLoss = planned.reduce((sum, bar) => sum + bar.nonReusableLoss, 0);
  return {
    bars: planned,
    exact: units.length <= EXACT_LIMIT && candidateBars.length <= 80,
    optimalityNote: units.length <= EXACT_LIMIT && candidateBars.length <= 80
      ? "proven optimal by exhaustive bounded search"
      : "heuristic best-fit decreasing; only the displayed lower bound is proven",
    lowerBoundNewBars,
    newBarsUsed,
    nonReusableLoss,
  };

  function finalizeBin(bin: Bin): PlannedBar {
    const count = bin.pieces.length;
    const pieceLength = bin.pieces.reduce((sum, piece) => sum + piece.length, 0);
    const baseline = params.endTrim + pieceLength + params.kerf * (count - 1);
    const remnantIfSeparated = bin.candidate.length - baseline - params.kerf;
    const reusable = Math.max(remnantIfSeparated, 0) >= params.reusableThreshold;
    const finalCutRequired = params.finalSeparationRule === "always" || reusable;
    const cuts = count - 1 + (finalCutRequired ? 1 : 0);
    const remnantLength = finalCutRequired ? remnantIfSeparated : bin.candidate.length - baseline;
    return {
      barCode: bin.candidate.code,
      barLength: bin.candidate.length,
      isRemnant: bin.candidate.isRemnant,
      pieces: bin.pieces,
      endTrim: params.endTrim,
      cuts,
      remnantLength,
      nonReusableLoss: params.endTrim + params.kerf * cuts + (reusable ? 0 : remnantLength),
      finalCutRequired,
    };
  }
}

function binCanAccept(bin: Bin, length: number, params: CutParams): boolean {
  const reserveFinalKerf = params.finalSeparationRule === "always" ? params.kerf : 0;
  return bin.load + length + reserveFinalKerf <= bin.candidate.length - params.endTrim;
}

function heuristicPack(units: PlannedPiece[], candidates: CandidateBar[], params: CutParams): Bin[] | null {
  const bins: Bin[] = [];
  const remaining = [...candidates].sort((a, b) =>
    Number(a.isRemnant) - Number(b.isRemnant) || a.length - b.length);
  for (const piece of units) {
    let target = bins
      .filter((bin) => binCanAccept(bin, piece.length, params))
      .sort((a, b) => remainingSpace(a, params) - remainingSpace(b, params))[0];
    if (!target) {
      const candidateIndex = remaining.findIndex((bar) => bar.length >= params.endTrim + piece.length);
      if (candidateIndex < 0) return null;
      const [candidate] = remaining.splice(candidateIndex, 1);
      target = { candidate, pieces: [], load: 0 };
      bins.push(target);
    }
    target.pieces.push(piece);
    target.load += piece.length + params.kerf;
  }
  return bins;
}

function remainingSpace(bin: Bin, params: CutParams): number {
  return bin.candidate.length - params.endTrim + params.kerf - bin.load;
}

function exactPack(units: PlannedPiece[], candidates: CandidateBar[], params: CutParams): Bin[] | null {
  let best: Bin[] | null = null;
  let bestScore = { newBars: Infinity, loss: Infinity };
  const bins: Bin[] = [];

  const binLoss = (bin: Bin): number => {
    const count = bin.pieces.length;
    const pieceLength = bin.pieces.reduce((sum, piece) => sum + piece.length, 0);
    const baseline = params.endTrim + pieceLength + params.kerf * (count - 1);
    const remnantIfSeparated = bin.candidate.length - baseline - params.kerf;
    const reusable = Math.max(remnantIfSeparated, 0) >= params.reusableThreshold;
    const finalCutRequired = params.finalSeparationRule === "always" || reusable;
    const cuts = count - 1 + (finalCutRequired ? 1 : 0);
    const remnantLength = finalCutRequired ? remnantIfSeparated : bin.candidate.length - baseline;
    return params.endTrim + params.kerf * cuts + (reusable ? 0 : remnantLength);
  };

  const visit = (index: number, newBars: number, loss: number) => {
    if (newBars > bestScore.newBars || (newBars === bestScore.newBars && loss >= bestScore.loss)) return;
    if (index === units.length) {
      bestScore = { newBars, loss };
      best = bins.map((bin) => ({ ...bin, pieces: [...bin.pieces] }));
      return;
    }
    const piece = units[index];
    const currentLoss = bins.reduce((sum, bin) => sum + binLoss(bin), 0);
    const tried = new Set<number>();
    for (const bin of bins) {
      const space = remainingSpace(bin, params);
      const reserveFinalKerf = params.finalSeparationRule === "always" ? params.kerf : 0;
      if (tried.has(space) || space < piece.length + params.kerf + reserveFinalKerf) continue;
      tried.add(space);
      bin.pieces.push(piece);
      bin.load += piece.length + params.kerf;
      visit(index + 1, newBars, currentLoss);
      bin.load -= piece.length + params.kerf;
      bin.pieces.pop();
    }
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (candidate.length < params.endTrim + piece.length) continue;
      if (bins.some((bin) => bin.candidate.code === candidate.code)) continue;
      const bin: Bin = { candidate, pieces: [piece], load: piece.length + params.kerf };
      bins.push(bin);
      visit(index + 1, newBars + (candidate.isRemnant ? 0 : 1), currentLoss);
      bins.pop();
    }
  };
  visit(0, 0, 0);
  return best;
}

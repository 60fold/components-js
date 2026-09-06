const BLOCK_SIZE = 256;

/** Exact all-series extrema over retained physical ring slots. @internal */
export class StreamingBoundsIndex {
  declare private readonly series: readonly Float64Array[];
  declare private readonly stackedSeries: readonly boolean[];
  declare private readonly blockCount: number;
  declare private readonly treeBase: number;
  declare private readonly minTree: Float64Array;
  declare private readonly maxTree: Float64Array;
  declare private readonly dirtyBlocks: Uint8Array;
  declare private readonly dirtyBlockIndices: Uint32Array;
  private dirtyBlockCount = 0;

  constructor(
    series: readonly Float64Array[],
    capacity: number,
    stackedSeries: readonly boolean[],
  ) {
    this.series = series;
    this.stackedSeries = stackedSeries;
    this.blockCount = Math.ceil(capacity / BLOCK_SIZE);
    let treeBase = 1;
    while (treeBase < this.blockCount) treeBase *= 2;
    this.treeBase = treeBase;
    this.minTree = new Float64Array(treeBase * 2);
    this.maxTree = new Float64Array(treeBase * 2);
    this.minTree.fill(Infinity);
    this.maxTree.fill(-Infinity);
    this.dirtyBlocks = new Uint8Array(this.blockCount);
    this.dirtyBlockIndices = new Uint32Array(this.blockCount);
  }

  get min(): number {
    return this.minTree[1];
  }

  get max(): number {
    return this.maxTree[1];
  }

  markDirty(physicalIndex: number): void {
    const block = Math.floor(physicalIndex / BLOCK_SIZE);
    if (block < 0 || block >= this.blockCount || this.dirtyBlocks[block] === 1) return;
    this.dirtyBlocks[block] = 1;
    this.dirtyBlockIndices[this.dirtyBlockCount++] = block;
  }

  rebuild(populatedLength: number): void {
    this.minTree.fill(Infinity);
    this.maxTree.fill(-Infinity);
    this.dirtyBlocks.fill(0);
    this.dirtyBlockCount = 0;
    const populatedBlocks = Math.ceil(populatedLength / BLOCK_SIZE);
    for (let block = 0; block < populatedBlocks; block++) {
      this.recomputeBlock(block, populatedLength);
    }
    for (let node = this.treeBase - 1; node > 0; node--) this.combineChildren(node);
  }

  flush(populatedLength: number): void {
    for (let i = 0; i < this.dirtyBlockCount; i++) {
      const block = this.dirtyBlockIndices[i];
      this.recomputeBlock(block, populatedLength);
      for (let node = (this.treeBase + block) >> 1; node > 0; node >>= 1) {
        this.combineChildren(node);
      }
      this.dirtyBlocks[block] = 0;
    }
    this.dirtyBlockCount = 0;
  }

  private combineChildren(node: number): void {
    const left = node * 2;
    this.minTree[node] = Math.min(this.minTree[left], this.minTree[left + 1]);
    this.maxTree[node] = Math.max(this.maxTree[left], this.maxTree[left + 1]);
  }

  private recomputeBlock(block: number, populatedLength: number): void {
    const start = block * BLOCK_SIZE;
    const end = Math.min(start + BLOCK_SIZE, populatedLength);
    let min = Infinity;
    let max = -Infinity;
    for (let physicalIndex = start; physicalIndex < end; physicalIndex++) {
      let positiveStack = 0;
      let negativeStack = 0;
      let hasStackValue = false;
      for (let s = 0; s < this.series.length; s++) {
        const value = this.series[s][physicalIndex];
        if (!Number.isFinite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
        if (this.stackedSeries[s]) {
          hasStackValue = true;
          if (value >= 0) positiveStack += value;
          else negativeStack += value;
        }
      }
      if (hasStackValue) {
        // Finite inputs can overflow their signed sums. Keep those infinities
        // for the renderer's existing final bounds normalization.
        if (negativeStack < min) min = negativeStack;
        if (positiveStack > max) max = positiveStack;
      }
    }
    const leaf = this.treeBase + block;
    this.minTree[leaf] = min;
    this.maxTree[leaf] = max;
  }
}

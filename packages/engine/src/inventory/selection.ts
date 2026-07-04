export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export class BoundedSmallestStrings {
  readonly #capacity: number;
  readonly #heap: string[] = [];
  #seen = 0;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  add(value: string): void {
    this.#seen += 1;
    if (this.#capacity === 0) return;
    if (this.#heap.length < this.#capacity) {
      this.#heap.push(value);
      this.#bubbleUp(this.#heap.length - 1);
      return;
    }
    const largest = this.#heap[0];
    if (largest !== undefined && compareCodeUnits(value, largest) < 0) {
      this.#heap[0] = value;
      this.#siftDown(0);
    }
  }

  get truncated(): boolean {
    return this.#seen > this.#capacity;
  }

  values(): string[] {
    return [...this.#heap].sort(compareCodeUnits);
  }

  #bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentValue = this.#heap[parent];
      const value = this.#heap[index];
      if (
        parentValue === undefined ||
        value === undefined ||
        compareCodeUnits(parentValue, value) >= 0
      ) {
        return;
      }
      this.#heap[parent] = value;
      this.#heap[index] = parentValue;
      index = parent;
    }
  }

  #siftDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      const leftValue = this.#heap[left];
      const largestValue = this.#heap[largest];
      if (
        leftValue !== undefined &&
        largestValue !== undefined &&
        compareCodeUnits(leftValue, largestValue) > 0
      ) {
        largest = left;
      }
      const rightValue = this.#heap[right];
      const nextLargestValue = this.#heap[largest];
      if (
        rightValue !== undefined &&
        nextLargestValue !== undefined &&
        compareCodeUnits(rightValue, nextLargestValue) > 0
      ) {
        largest = right;
      }
      if (largest === index) return;
      const value = this.#heap[index];
      const replacement = this.#heap[largest];
      if (value === undefined || replacement === undefined) return;
      this.#heap[index] = replacement;
      this.#heap[largest] = value;
      index = largest;
    }
  }
}

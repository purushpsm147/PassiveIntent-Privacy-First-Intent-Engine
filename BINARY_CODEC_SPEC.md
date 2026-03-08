<!--
  Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>

  This source code is licensed under the AGPL-3.0-only license found in the
  LICENSE file in the root directory of this source tree.
-->

# MarkovGraph Binary Codec Spec (v2)

This document defines the binary wire format used by `MarkovGraph.toBinary()` and `MarkovGraph.fromBinary()`.

## Version

- **Current version byte:** `0x02`
- `fromBinary()` must reject any version it does not explicitly support.

## Endianness

- All multi-byte numeric values are **little-endian**.

## Layout

1. `u8 version`
2. `u16 stateCount`
3. Repeated `stateCount` times:
   - `u16 utf8LabelByteLength`
   - `u8[labelLength] utf8LabelBytes`
4. `u16 freedIndexCount`
5. Repeated `freedIndexCount` times:
   - `u16 freedIndex`
6. `u16 rowCount`
7. Repeated `rowCount` times:
   - `u16 fromIndex`
   - `u32 totalOutgoingTransitions`
   - `u16 edgeCount`
   - Repeated `edgeCount` times:
     - `u16 toIndex`
     - `u32 transitionCount`

## Tombstones and `freedIndices`

`MarkovGraph` uses tombstoned slots (`''`) to preserve index stability. Binary v2 stores freed indices explicitly so deserialization can reconstruct reusable slots without accidentally reviving tombstones.

Validation rules enforced by `fromBinary()`:

- If an index appears in `freedIndices`, its label must be `''`.
- If a label is `''`, its index must appear in `freedIndices`.

## Compatibility contract

- `toBinary()` and `fromBinary()` are required to round-trip graph probabilities and freed-slot semantics.
- The fixture `tests/fixtures/markov-binary-v2-golden.json` acts as a golden compatibility artifact for regression testing.

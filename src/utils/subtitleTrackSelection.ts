export type SelectableTextTrack = {
  mode: 'disabled' | 'hidden' | 'showing';
};

export function applySelectedTextTrackMode<T extends SelectableTextTrack>(
  tracks: readonly T[],
  selectionId: string,
): T | null {
  const match = /^internal:(0|[1-9]\d*)$/.exec(selectionId);
  const selectedIndex = match ? Number(match[1]) : -1;
  const selected = selectedIndex >= 0 && selectedIndex < tracks.length
    ? tracks[selectedIndex]
    : null;

  tracks.forEach((track, index) => {
    track.mode = selected && index === selectedIndex ? 'hidden' : 'disabled';
  });
  return selected;
}


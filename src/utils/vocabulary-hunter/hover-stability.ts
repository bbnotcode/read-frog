interface RectLike {
  left: number
  right: number
  top: number
  bottom: number
}

export function pointIntersectsRect(clientX: number, clientY: number, rect: RectLike, padding = 3) {
  return (
    clientX >= rect.left - padding &&
    clientX <= rect.right + padding &&
    clientY >= rect.top - padding &&
    clientY <= rect.bottom + padding
  )
}

export function pointIntersectsAnyRect(
  clientX: number,
  clientY: number,
  rects: Iterable<RectLike>,
  padding = 3,
) {
  for (const rect of rects) {
    if (pointIntersectsRect(clientX, clientY, rect, padding)) return true
  }
  return false
}

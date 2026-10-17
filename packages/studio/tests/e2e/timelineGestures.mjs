/**
 * Hover a timeline clip's end edge until its trim handle mounts, and return the press point.
 * The handle only renders on hover, so a press before it mounts would start a move instead.
 */
export async function hoverClipEndEdge(page, clipSelector, box) {
  const edgeX = box.x + box.width - 3;
  const midY = box.y + box.height / 2;
  await page.mouse.move(edgeX - 20, midY);
  await page.mouse.move(edgeX, midY);
  await page.waitForFunction(
    (sel) =>
      [...document.querySelectorAll(`${sel} div`)].some((d) => d.style.cursor === "col-resize"),
    { timeout: 10_000 },
    clipSelector,
  );
  return { edgeX, midY };
}

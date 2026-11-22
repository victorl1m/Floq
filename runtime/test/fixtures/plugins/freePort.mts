import { createServer } from "node:net";
/** A free TCP port on loopback. */
export const createNetServer = (): Promise<number> => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

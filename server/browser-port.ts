// WHATWG Fetch port-blocking table, checked 2026-09-28:
// https://fetch.spec.whatwg.org/#port-blocking
const blockedPorts = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587,
  601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export async function startBrowserService<T extends { port: number; close: () => Promise<void> }>(requestedPort: number, start: () => Promise<T>): Promise<T> {
  if (requestedPort !== 0 && blockedPorts.has(requestedPort)) {
    throw new Error(`PORT=${requestedPort} 是瀏覽器禁止連線的埠，請改用 3000 或設為 0 自動選擇。`);
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const service = await start();
    if (!blockedPorts.has(service.port)) return service;
    // Fully close HMR, HTTP and databases before asking the OS for another port.
    await service.close();
    if (requestedPort !== 0) break;
  }
  throw new Error('未能自動取得瀏覽器可用的埠，請指定 PORT=3000 或其他可用埠後重試。');
}

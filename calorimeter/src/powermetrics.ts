// Wraps `sudo powermetrics` as a continuously-running sampler and exposes
// timestamped SoC power samples (CPU + GPU + ANE, in mW) for integration.

export interface Sample {
  t: number; // Date.now() ms when the sample block completed
  mw: number; // combined CPU+GPU+ANE power in mW
  cpu: number;
  gpu: number;
  ane: number;
}

export class PowerSampler {
  samples: Sample[] = [];
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private reading: Promise<void> | null = null;
  private current: { cpu?: number; gpu?: number; ane?: number } = {};

  constructor(private intervalMs: number) {}

  async start(): Promise<void> {
    this.proc = Bun.spawn(
      [
        "sudo",
        "-n",
        "powermetrics",
        "-i",
        String(this.intervalMs),
        "-s",
        "cpu_power,gpu_power,ane_power",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    this.reading = this.readLoop();

    // Fail fast if sudo has no cached credentials or powermetrics dies.
    const first = await Promise.race([
      this.waitForSamples(1),
      Bun.sleep(this.intervalMs * 20 + 3000).then(() => "timeout" as const),
    ]);
    if (first === "timeout") {
      const err = await new Response(this.proc.stderr as ReadableStream).text();
      this.stop();
      throw new Error(
        `powermetrics produced no samples. Run \`sudo -v\` first to cache credentials.\nstderr: ${err.slice(0, 500)}`,
      );
    }
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc!.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        this.handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
  }

  private handleLine(line: string): void {
    const part = line.match(/^(CPU|GPU|ANE) Power:\s+(\d+)\s*mW/);
    if (part) {
      const key = part[1].toLowerCase() as "cpu" | "gpu" | "ane";
      this.current[key] = parseInt(part[2], 10);
      return;
    }
    // "Combined Power (CPU + GPU + ANE): 590 mW" closes a sample block.
    const combined = line.match(/^Combined Power.*:\s+(\d+)\s*mW/);
    if (combined) {
      this.samples.push({
        t: Date.now(),
        mw: parseInt(combined[1], 10),
        cpu: this.current.cpu ?? 0,
        gpu: this.current.gpu ?? 0,
        ane: this.current.ane ?? 0,
      });
      this.current = {};
    }
  }

  async waitForSamples(n: number): Promise<"ok"> {
    while (this.samples.length < n) await Bun.sleep(50);
    return "ok";
  }

  /** Average combined power (mW) over samples in [t0, t1]. */
  averageMw(t0: number, t1: number): number {
    const win = this.samples.filter((s) => s.t >= t0 && s.t <= t1);
    if (win.length === 0) return 0;
    return win.reduce((a, s) => a + s.mw, 0) / win.length;
  }

  /**
   * Integrate energy over [t0, t1] above a baseline, in Joules.
   * Rectangle rule over inter-sample gaps; each sample's power is applied
   * to the interval since the previous sample.
   */
  energyJoules(t0: number, t1: number, baselineMw: number): number {
    const win = this.samples.filter((s) => s.t >= t0 && s.t <= t1);
    if (win.length < 2) return 0;
    let joules = 0;
    for (let i = 1; i < win.length; i++) {
      const dtSec = (win[i].t - win[i - 1].t) / 1000;
      joules += (Math.max(0, win[i].mw - baselineMw) / 1000) * dtSec;
    }
    return joules;
  }

  sampleCountIn(t0: number, t1: number): number {
    return this.samples.filter((s) => s.t >= t0 && s.t <= t1).length;
  }

  stop(): void {
    this.proc?.kill();
  }
}

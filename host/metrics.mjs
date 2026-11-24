// All times are monotonic milliseconds. Only compare clocks after a four-timestamp exchange.
const windowMs = 5000;
const maxErrorMs = 50;
function percentile(rows, key, fraction) {
  const sorted = rows
    .map((row) => row[key])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(fraction * sorted.length) - 1] : null;
}

export class FrameStats {
  reset(now) {
    this.frames = new Map();
    this.reports = [{ at: now, received: 0, processed: 0 }];
    this.samples = [];
    this.clocks = [];
    this.last = {
      seq: 0,
      received: 0,
      processed: 0,
      processedSeq: 0,
      sampled: 0,
      dropped: 0,
    };
    this.modelBytes = 0;
  }
  capture(seq, at) {
    this.frames.set(seq, at);
    if (this.frames.size > 1500)
      this.frames.delete(this.frames.keys().next().value);
  }
  clock(t0, t1, t2, t3) {
    const rtt = t3 - t0 - (t2 - t1);
    if (
      ![t0, t1, t2, t3].every(Number.isFinite) ||
      t2 < t1 ||
      rtt < 0 ||
      rtt > 5000
    )
      return;
    this.clocks.push({
      at: t3,
      offset: (t1 - t0 + (t2 - t3)) / 2,
      error: rtt / 2,
    });
    this.clocks = this.clocks.filter((c) => c.at >= t3 - 15000).slice(-10);
  }
  calibration(now) {
    return this.clocks
      .filter((c) => c.at >= now - 15000)
      .sort((a, b) => a.error - b.error)[0];
  }
  progress(report, now) {
    const {
      seq,
      received,
      processed,
      processedSeq,
      sampled = 0,
      dropped = 0,
      samples = [],
    } = report;
    const counts = { seq, received, processed, processedSeq, sampled, dropped };
    const measuredMs = report.measuredMs;
    if (
      measuredMs !== undefined &&
      (!Number.isFinite(measuredMs) ||
        measuredMs < (this.reports.at(-1).measuredMs ?? -Infinity))
    ) {
      throw Error("Invalid receiver clock");
    }
    if (
      Object.entries(counts).some(
        ([key, n]) => !Number.isSafeInteger(n) || n < this.last[key],
      ) ||
      !this.frames.has(seq) ||
      received > seq ||
      processed > received ||
      processedSeq > seq ||
      (processed === 0 && processedSeq !== 0) ||
      !Array.isArray(samples) ||
      samples.length > 256
    )
      throw Error("Invalid model progress");
    this.last = counts;
    this.reports.push({ at: now, measuredMs, received, processed });
    while (
      this.reports.length > 2 &&
      (this.reports[1].at <= now - windowMs || this.reports.length > 256)
    )
      this.reports.shift();
    const sync = this.calibration(now);
    for (const sample of samples) {
      const t = this.frames.get(sample.seq);
      if (
        t === undefined ||
        sample.seq > seq ||
        !Number.isFinite(sample.receivedMs)
      )
        continue;
      const hasProcessing =
        Number.isFinite(sample.processedMs) &&
        sample.processedMs >= sample.receivedMs;
      const calibrated = sync && sync.error <= maxErrorMs;
      // A later report may complete a sample whose receive time was already acknowledged.
      const row = this.samples.findLast((r) => r.seq === sample.seq) ?? {
        seq: sample.seq,
        at: now,
      };
      if (row.ack === undefined) {
        row.ack = now - t;
        if (calibrated)
          row.rx = Math.max(0, sample.receivedMs - sync.offset - t);
        this.samples.push(row);
      }
      if (hasProcessing && row.visualAck === undefined) {
        row.processing = sample.processedMs - sample.receivedMs;
        row.visualAck = now - t;
        if (calibrated)
          row.visual = Math.max(0, sample.processedMs - sync.offset - t);
      }
    }
    this.samples = this.samples.filter((r) => r.at >= now - 30000).slice(-1500);
  }
  confirmed(seq) {
    return (
      this.last.processed > 0 &&
      (seq === this.last.processedSeq ||
        this.samples.some(
          (row) => row.seq === seq && row.visualAck !== undefined,
        ))
    );
  }
  view(now) {
    const rows = this.samples.filter((r) => r.at >= now - 30000);
    const first = this.reports[0],
      last = this.reports.at(-1);
    const receiverFirst =
      first.measuredMs === undefined ? this.reports[1] : first;
    const measured =
      last.measuredMs !== undefined &&
      receiverFirst?.measuredMs < last.measuredMs;
    const secs = measured
      ? (last.measuredMs - receiverFirst.measuredMs) / 1000
      : (now - first.at) / 1000;
    const baseline = measured ? receiverFirst : first;
    const rate = (key) =>
      secs > 0 && now - last.at < 1500 ? (last[key] - baseline[key]) / secs : 0;
    const capture = [...this.frames.values()].filter(
      (t) => t >= now - windowMs,
    );
    const sync = this.calibration(now),
      calibrated = sync && sync.error <= maxErrorMs;
    return {
      captureFps:
        capture.length > 1
          ? ((capture.length - 1) * 1000) / Math.max(1, now - capture[0])
          : 0,
      rxFps: rate("received"),
      processedFps: rate("processed"),
      rxP50: calibrated ? percentile(rows, "rx", 0.5) : null,
      rxP95: calibrated ? percentile(rows, "rx", 0.95) : null,
      processedP95: calibrated ? percentile(rows, "visual", 0.95) : null,
      ackP95: percentile(rows, "ack", 0.95),
      visualAckP95: percentile(rows, "visualAck", 0.95),
      processingP95: percentile(rows, "processing", 0.95),
      clockErrorMs: sync?.error ?? null,
      received: this.last.received,
      processed: this.last.processed,
      sampled: this.last.sampled,
      dropped: this.last.dropped,
      sequenceGaps: this.last.seq - this.last.received,
      modelBytes: this.modelBytes,
    };
  }
}

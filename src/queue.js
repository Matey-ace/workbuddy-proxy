// 并发闸门 + 队列，防止额度被瞬间打爆 / 触发上游限流
export class Limiter {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.waiters = [];
    this.peak = 0;
  }
  get stats() {
    return { active: this.active, queued: this.waiters.length, max: this.max, peak: this.peak };
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active++;
        this.peak = Math.max(this.peak, this.active);
        resolve(() => this.release());
      });
    });
  }
  release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
  setMax(n) {
    this.max = Math.max(1, n | 0);
    while (this.active < this.max && this.waiters.length) {
      const next = this.waiters.shift();
      if (next) {
        this.active++;
        next();
      }
    }
  }
}

export class SemaphoreLimiter extends Limiter {}

// 简单令牌桶（按分钟请求数限流，可选）
export class RateLimiter {
  constructor({ capacity = 60, refillPerSec = 1 } = {}) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerSec = refillPerSec;
    this.last = Date.now();
  }
  take(n = 1) {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
  refill() {
    const now = Date.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
  }
  msUntilNext(n = 1) {
    this.refill();
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.refillPerSec) * 1000);
  }
}

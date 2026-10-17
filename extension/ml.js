// Posture model: turns a window of accelerometer readings into class probabilities.
// The feature code here must stay identical to ml/features.py, which the model was trained on.

const PostureML = (() => {
  // Rotation that moves the calibrated "good posture" gravity direction onto +z.
  // After rotating, z is "how upright", and x/y say which way you are tilting.
  function baselineRotation(b) {
    const m = Math.hypot(...b);
    const [bx, by, bz] = m ? b.map((v) => v / m) : [0, 0, 1];
    // v = b x z, c = b . z
    const v = [by, -bx, 0];
    const c = bz;
    const s2 = v[0] * v[0] + v[1] * v[1];
    if (s2 < 1e-12) {
      return c > 0 ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
    }
    const k = (1 - c) / s2;
    const K = [[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]];
    const R = [];
    for (let i = 0; i < 3; i++) {
      R.push([]);
      for (let j = 0; j < 3; j++) {
        let kk = 0;
        for (let n = 0; n < 3; n++) kk += K[i][n] * K[n][j];
        R[i].push((i === j ? 1 : 0) + K[i][j] + kk * k);
      }
    }
    return R;
  }

  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const std = (a) => {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
  };

  // samples: array of [x, y, z]; baseline: [x, y, z]. Returns 14 numbers.
  function features(samples, baseline) {
    const R = baselineRotation(baseline);
    const ux = [], uy = [], uz = [], ang = [], mag = [];
    for (const v of samples) {
      const r = R.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
      const m = Math.hypot(...v) || 1e-9;
      ux.push(r[0] / m); uy.push(r[1] / m); uz.push(r[2] / m);
      ang.push(Math.acos(Math.min(1, Math.max(-1, r[2] / m))) * 180 / Math.PI);
      mag.push(m);
    }
    const n = samples.length;
    const im = (n - 1) / 2, am = mean(ang);
    let num = 0, den = 0, jerk = 0;
    for (let i = 0; i < n; i++) {
      num += (i - im) * (ang[i] - am);
      den += (i - im) * (i - im);
      if (i > 0) jerk += Math.abs(ux[i] - ux[i - 1]) + Math.abs(uy[i] - uy[i - 1]) + Math.abs(uz[i] - uz[i - 1]);
    }
    return [
      mean(ux), mean(uy), mean(uz),
      std(ux), std(uy), std(uz),
      am, std(ang), Math.min(...ang), Math.max(...ang), den ? num / den : 0,
      mean(mag), std(mag),
      n > 1 ? jerk / (n - 1) : 0,
    ];
  }

  // Forward pass of the exported scikit-learn MLP. Returns probabilities, one per model.classes.
  function predict(model, feats) {
    let h = feats.map((x, i) => (x - model.scaler.mean[i]) / model.scaler.scale[i]);
    model.layers.forEach((layer, li) => {
      const out = layer.b.slice();
      for (let i = 0; i < h.length; i++) {
        for (let j = 0; j < out.length; j++) out[j] += h[i] * layer.W[i][j];
      }
      h = li < model.layers.length - 1 ? out.map((x) => Math.max(0, x)) : out;
    });
    const mx = Math.max(...h);
    const e = h.map((x) => Math.exp(x - mx));
    const sum = e.reduce((s, x) => s + x, 0);
    return e.map((x) => x / sum);
  }

  async function load() {
    try {
      const res = await fetch(chrome.runtime.getURL('model.json'));
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null; // no model trained yet
    }
  }

  return { features, predict, load, baselineRotation };
})();

if (typeof module !== 'undefined') module.exports = PostureML; // for the Node parity test

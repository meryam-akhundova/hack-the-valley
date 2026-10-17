"""Window features for the posture model.

Must stay identical to extension/ml.js, which recomputes these in the browser.
"""
import numpy as np

WINDOW = 20  # samples (2 s at 10 readings/s)
HOP = 5      # slide 0.5 s between windows

FEATURE_NAMES = [
    "ux_mean", "uy_mean", "uz_mean",
    "ux_std", "uy_std", "uz_std",
    "angle_mean", "angle_std", "angle_min", "angle_max", "angle_slope",
    "mag_mean", "mag_std",
    "jerk",
]


def baseline_rotation(b):
    """Rotation that moves the calibrated good-posture gravity direction onto +z."""
    b = np.asarray(b, dtype=float)
    m = np.linalg.norm(b)
    bx, by, bz = b / m if m else (0.0, 0.0, 1.0)
    v = np.array([by, -bx, 0.0])  # b x z
    c = bz                        # b . z
    s2 = v[0] ** 2 + v[1] ** 2
    if s2 < 1e-12:
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K * ((1 - c) / s2)


def features(samples, baseline):
    """samples: (n, 3) raw readings; baseline: (3,). Returns 14 features."""
    samples = np.asarray(samples, dtype=float)
    R = baseline_rotation(baseline)
    r = samples @ R.T
    mag = np.linalg.norm(samples, axis=1)
    mag_safe = np.where(mag == 0, 1e-9, mag)
    u = r / mag_safe[:, None]
    ang = np.degrees(np.arccos(np.clip(u[:, 2], -1, 1)))
    n = len(samples)
    idx = np.arange(n) - (n - 1) / 2
    den = (idx ** 2).sum()
    slope = (idx * (ang - ang.mean())).sum() / den if den else 0.0
    jerk = np.abs(np.diff(u, axis=0)).sum() / (n - 1) if n > 1 else 0.0
    return np.array([
        *u.mean(axis=0),
        *u.std(axis=0),
        ang.mean(), ang.std(), ang.min(), ang.max(), slope,
        mag.mean(), mag.std(),
        jerk,
    ])


def windows(df):
    """Slice one recording (a DataFrame with x,y,z,bx,by,bz) into feature rows."""
    xyz = df[["x", "y", "z"]].to_numpy()
    base = df[["bx", "by", "bz"]].iloc[0].to_numpy()
    return [features(xyz[i:i + WINDOW], base) for i in range(0, len(df) - WINDOW + 1, HOP)]

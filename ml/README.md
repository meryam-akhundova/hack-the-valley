# Posture model

A small neural network that classifies 2-second windows of accelerometer data
(sensor on the back of the neck) as `upright`, `slouch_forward`, `lean_back`,
`lean_side` or `moving`. It replaces the fixed tilt threshold in the extension:
it ignores movement like reaching or turning, and dims harder the more confident
it is that you're slouching.

## 1. Record data

1. Load `extension/` in Chrome, open the monitor tab, connect and calibrate.
2. Open **Record training data**, enter your name, pick a posture, click **Record**.
   Hold the posture (or keep doing the movement) for 30–60 s, then click **Stop**.
3. Each take downloads as a CSV. Move them into `ml/data/`.

Aim for 2+ takes per posture per person. Everyone should record every posture,
with the sensor mounted the same way.

## 2. Train

```
python3 -m venv ml/.venv
ml/.venv/bin/pip install -r ml/requirements.txt
ml/.venv/bin/python ml/train.py
```

This prints accuracy on people the model never saw in training, compares it with the
old tilt rule, and writes `extension/model.json`. Reload the extension to use it.

## Keeping Python and JS in sync

`ml/features.py` and `extension/ml.js` compute the same 14 features. If you change
one, change the other, or the model will get different inputs from the ones it was trained on.

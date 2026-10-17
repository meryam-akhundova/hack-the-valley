"""Train the posture classifier and export it for the extension.

    python ml/train.py              # reads ml/data/*.csv, writes extension/model.json

Each CSV is one recording from the extension's Record panel
(columns: t,x,y,z,bx,by,bz,label,person).
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import GroupKFold, LeaveOneGroupOut
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from features import FEATURE_NAMES, HOP, WINDOW, windows

ROOT = Path(__file__).resolve().parent
GOOD_CLASSES = {"upright", "moving"}  # everything else counts as bad posture
THRESHOLD_DEG = 15                    # the extension's default tilt threshold, for comparison


def load(data_dir):
    X, y, person, take = [], [], [], []
    files = sorted(Path(data_dir).glob("*.csv"))
    for f in files:
        df = pd.read_csv(f)
        if len(df) < WINDOW:
            print(f"skip {f.name}: only {len(df)} readings")
            continue
        rows = windows(df)
        X += rows
        y += [str(df["label"].iloc[0])] * len(rows)
        person += [str(df["person"].iloc[0])] * len(rows)
        take += [f.name] * len(rows)
    if not X:
        raise SystemExit(f"No recordings in {data_dir}. Record some with the extension first.")
    return np.array(X), np.array(y), np.array(person), np.array(take)


def make_mlp():
    return make_pipeline(
        StandardScaler(),
        MLPClassifier(hidden_layer_sizes=(16,), alpha=1e-3, max_iter=2000, random_state=0),
    )


def make_rf():
    return RandomForestClassifier(n_estimators=200, min_samples_leaf=3, random_state=0)


def cross_val(make, X, y, groups, splitter):
    pred = np.empty_like(y)
    for tr, te in splitter.split(X, y, groups):
        pred[te] = make().fit(X[tr], y[tr]).predict(X[te])
    return pred


def is_bad(labels):
    return np.array([l not in GOOD_CLASSES for l in labels])


def export(model, classes, path, cv_acc):
    scaler, mlp = model.named_steps["standardscaler"], model.named_steps["mlpclassifier"]
    if len(classes) == 2:
        raise SystemExit("Need at least 3 classes to export (sklearn's 2-class MLP uses a single sigmoid output).")
    out = {
        "trained_at": time.strftime("%Y-%m-%d %H:%M"),
        "window": WINDOW,
        "hop": HOP,
        "features": FEATURE_NAMES,
        "classes": list(classes),
        "good_classes": sorted(GOOD_CLASSES & set(classes)),
        "cv_accuracy": round(float(cv_acc), 3),
        "scaler": {"mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist()},
        "layers": [{"W": W.tolist(), "b": b.tolist()} for W, b in zip(mlp.coefs_, mlp.intercepts_)],
    }
    path.write_text(json.dumps(out))
    print(f"\nWrote {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=ROOT / "data")
    ap.add_argument("--out", default=ROOT.parent / "extension" / "model.json", type=Path)
    args = ap.parse_args()

    X, y, person, take = load(args.data)
    classes = sorted(set(y.tolist()))
    people = sorted(set(person.tolist()))
    print(f"{len(X)} windows from {len(set(take))} recordings, {len(people)} people, classes: {classes}")
    print(pd.crosstab(person, y), "\n")

    # Test on people the model has never seen; with one person, on recordings it has never seen.
    if len(people) > 1:
        splitter, groups, how = LeaveOneGroupOut(), person, "leave-one-person-out"
    else:
        splitter, groups, how = GroupKFold(n_splits=min(5, len(set(take)))), take, "held-out recordings"

    mlp_pred = cross_val(make_mlp, X, y, groups, splitter)
    rf_pred = cross_val(make_rf, X, y, groups, splitter)
    mlp_acc, rf_acc = (mlp_pred == y).mean(), (rf_pred == y).mean()

    print(f"=== Cross-validation ({how}) ===")
    print(f"MLP accuracy:           {mlp_acc:.1%}  <- exported to the extension")
    print(f"Random forest accuracy: {rf_acc:.1%}")
    print("\nMLP per-class report:")
    print(classification_report(y, mlp_pred, zero_division=0))
    print("Confusion matrix (rows = true, cols = predicted):")
    print(pd.DataFrame(confusion_matrix(y, mlp_pred, labels=classes), index=classes, columns=classes), "\n")

    # The question that matters for dimming: is this bad posture or not?
    truth = is_bad(y)
    angle_mean = X[:, FEATURE_NAMES.index("angle_mean")]
    print("=== Bad posture yes/no (what decides dimming) ===")
    print(f"Old tilt rule (> {THRESHOLD_DEG}°): {((angle_mean > THRESHOLD_DEG) == truth).mean():.1%}")
    print(f"MLP:                    {(is_bad(mlp_pred) == truth).mean():.1%}")
    if "moving" in classes:
        mv = y == "moving"
        print(f"False alarms while moving: tilt rule {(angle_mean[mv] > THRESHOLD_DEG).mean():.1%}, "
              f"MLP {is_bad(mlp_pred[mv]).mean():.1%}")

    export(make_mlp().fit(X, y), classes, args.out, mlp_acc)


if __name__ == "__main__":
    main()

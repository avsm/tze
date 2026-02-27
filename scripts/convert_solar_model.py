#!/usr/bin/env python3
"""Convert solar_unet.pth to ONNX format and extract normalization stats."""

import json
import sys
from pathlib import Path

import numpy as np
import torch

# Add tessera-cnn-example to path so we can import the UNet class
TESSERA_CNN_DIR = Path.home() / "src/git/sadiqj/tessera-cnn-example"
sys.path.insert(0, str(TESSERA_CNN_DIR))

from models import UNet

CHECKPOINT_PATH = TESSERA_CNN_DIR / "solar_unet.pth"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "apps/viewer/public/models"

def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Load checkpoint
    print(f"Loading checkpoint: {CHECKPOINT_PATH}")
    model, checkpoint = UNet.from_checkpoint(str(CHECKPOINT_PATH), device="cpu")
    model.eval()

    print(f"Model config: {checkpoint['model_config']}")
    total_params = sum(p.numel() for p in model.parameters())
    print(f"Total parameters: {total_params:,}")

    # Extract normalization stats
    mean = np.array(checkpoint["mean"], dtype=np.float32)
    std = np.array(checkpoint["std"], dtype=np.float32)
    print(f"Mean shape: {mean.shape}, Std shape: {std.shape}")

    # Save stats as JSON
    stats_path = OUTPUT_DIR / "solar_unet_stats.json"
    stats = {
        "mean": mean.tolist(),
        "std": std.tolist(),
        "model_config": checkpoint["model_config"],
    }
    with open(stats_path, "w") as f:
        json.dump(stats, f)
    print(f"Stats saved: {stats_path}")

    # Export to ONNX
    onnx_path = OUTPUT_DIR / "solar_unet.onnx"
    dummy_input = torch.randn(1, 128, 64, 64)

    torch.onnx.export(
        model,
        dummy_input,
        str(onnx_path),
        opset_version=18,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={
            "input": {0: "batch", 2: "height", 3: "width"},
            "output": {0: "batch", 2: "height", 3: "width"},
        },
    )

    onnx_size = onnx_path.stat().st_size
    print(f"ONNX model saved: {onnx_path} ({onnx_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()

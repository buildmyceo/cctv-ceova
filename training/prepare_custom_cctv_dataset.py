#!/usr/bin/env python3
"""
CEOVA CCTV // Custom Dataset Preparation Tool for Kaggle Training
training/prepare_custom_cctv_dataset.py

Transforms raw CCTV person crops or folder structures into the standard
Market-1501 Re-ID format, compresses it to a zip file, and prepares it
for 1-click upload to https://www.kaggle.com.

Expected Input Structure (Example):
  my_cctv_crops/
    ├── staff_rahul/
    │   ├── crop1.jpg
    │   └── crop2.jpg
    ├── customer_001/
    │   ├── cam1_01.jpg
    │   └── cam2_01.jpg
    └── visitor_priya/
        ├── frame10.png
        └── frame11.png

Output Structure:
  cctv_kaggle_dataset/
    ├── bounding_box_train/
    │   ├── 0001_c1s1_000001_00.jpg
    │   ├── 0001_c1s1_000002_00.jpg
    │   ├── 0002_c1s1_000001_00.jpg
    │   └── ...
    ├── bounding_box_test/
    ├── query/
    ├── metadata.json
    └── cctv_kaggle_dataset.zip (Ready for Kaggle!)
"""

import os
import sys
import shutil
import zipfile
import json
import argparse
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("PIL (Pillow) not installed. Installing Pillow...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pillow"])
    from PIL import Image


def process_custom_dataset(input_dir, output_dir, zip_output=True, train_val_split=0.85):
    input_path = Path(input_dir)
    out_path = Path(output_dir)

    train_dir = out_path / "bounding_box_train"
    val_dir = out_path / "bounding_box_test"
    query_dir = out_path / "query"

    train_dir.mkdir(parents=True, exist_ok=True)
    val_dir.mkdir(parents=True, exist_ok=True)
    query_dir.mkdir(parents=True, exist_ok=True)

    identity_dirs = [d for d in input_path.iterdir() if d.is_dir() and not d.name.startswith('.')]
    
    if not identity_dirs:
        print(f"❌ No subdirectories found in '{input_dir}'.")
        print("Please arrange person crops in subfolders per identity (e.g. 'staff_01/', 'customer_01/').")
        return None

    print(f"🔍 Found {len(identity_dirs)} unique identities in {input_dir}")

    metadata = {
        "identities": {},
        "total_train_images": 0,
        "total_val_images": 0,
        "total_query_images": 0
    }

    global_pid = 1

    for id_folder in sorted(identity_dirs):
        id_name = id_folder.name
        img_files = [f for f in id_folder.iterdir() if f.suffix.lower() in ['.jpg', '.jpeg', '.png', '.webp']]
        
        if not img_files:
            continue

        metadata["identities"][id_name] = {
            "pid": global_pid,
            "crop_count": len(img_files)
        }

        # Determine camera ID from filenames if available (e.g. cam2_01.jpg -> cam 2)
        train_count = int(len(img_files) * train_val_split)
        train_count = max(1, train_count) if len(img_files) > 1 else 1

        for idx, img_path in enumerate(sorted(img_files)):
            # Guess camera index from filename or alternate
            cam_idx = 1
            name_lower = img_path.name.lower()
            if "cam" in name_lower or "c" in name_lower:
                for c in range(1, 10):
                    if f"cam{c}" in name_lower or f"cam_{c}" in name_lower or f"c{c}" in name_lower:
                        cam_idx = c
                        break
            else:
                cam_idx = (idx % 4) + 1

            # Standard 256x128 crop resize
            try:
                with Image.open(img_path) as img:
                    img_rgb = img.convert('RGB')
                    if img_rgb.size != (128, 256):
                        img_rgb = img_rgb.resize((128, 256), Image.Resampling.BILINEAR)
                    
                    # Format: [PID:04d]_c[Cam]s1_[Seq:06d]_00.jpg
                    fname = f"{global_pid:04d}_c{cam_idx}s1_{idx+1:06d}_00.jpg"

                    if idx < train_count:
                        dest_file = train_dir / fname
                        metadata["total_train_images"] += 1
                    else:
                        dest_file = val_dir / fname
                        metadata["total_val_images"] += 1
                        # If first validation image, also add to query set
                        if idx == train_count:
                            q_file = query_dir / fname
                            img_rgb.save(q_file, quality=95)
                            metadata["total_query_images"] += 1

                    img_rgb.save(dest_file, quality=95)
            except Exception as e:
                print(f"⚠️ Warning: Could not process {img_path}: {e}")

        global_pid += 1

    # Save metadata JSON
    meta_path = out_path / "metadata.json"
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)

    print("\n✅ Dataset conversion complete!")
    print(f"  Total IDs:          {len(metadata['identities'])}")
    print(f"  Training Crops:     {metadata['total_train_images']} in {train_dir}")
    print(f"  Validation Crops:   {metadata['total_val_images']} in {val_dir}")
    print(f"  Query Crops:        {metadata['total_query_images']} in {query_dir}")

    # Create ZIP archive
    if zip_output:
        zip_filename = out_path.with_suffix('.zip')
        print(f"\n📦 Compressing to {zip_filename} for Kaggle upload...")
        with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, _, files in os.walk(out_path):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, out_path.parent)
                    zipf.write(file_path, arcname)
        print(f"🎉 Created '{zip_filename}' ({os.path.getsize(zip_filename) / 1024:.1f} KB).")
        print("\n🚀 Next Steps:")
        print("1. Go to https://www.kaggle.com/datasets")
        print("2. Click 'New Dataset', drag and drop this zip file, and name it 'ceova-cctv-reid'")
        print("3. In your Kaggle Notebook, click 'Add Data' and select your new dataset!")
        return str(zip_filename)

    return str(out_path)


def generate_sample_cctv_crops(sample_dir):
    """Generates a small demo dataset with 5 simulated identities to test the tool."""
    path = Path(sample_dir)
    path.mkdir(parents=True, exist_ok=True)

    identities = ["staff_reception", "staff_security", "customer_alice", "customer_bob", "delivery_agent"]
    colors = [(20, 60, 180), (30, 30, 30), (200, 50, 50), (40, 160, 60), (220, 140, 20)]

    for name, col in zip(identities, colors):
        id_dir = path / name
        id_dir.mkdir(exist_ok=True)
        for i in range(1, 7):
            img = Image.new('RGB', (128, 256), color=(240, 240, 240))
            # Simulate torso color
            from PIL import ImageDraw
            draw = ImageDraw.Draw(img)
            # Head
            draw.ellipse([45, 15, 83, 50], fill=(210, 170, 140))
            # Torso
            draw.rectangle([20, 50, 108, 160], fill=col)
            # Legs
            draw.rectangle([30, 160, 98, 250], fill=(50, 55, 60))
            img.save(id_dir / f"cam{((i % 3) + 1)}_{i:02d}.jpg")

    print(f"✨ Created sample CCTV crops in '{sample_dir}'")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CEOVA CCTV Kaggle Dataset Preparer")
    parser.add_argument("--input", "-i", type=str, default="sample_cctv_crops", help="Input directory of identity crop folders")
    parser.add_argument("--output", "-o", type=str, default="cctv_kaggle_dataset", help="Output directory for Market-1501 format")
    parser.add_argument("--create-sample", action="store_true", help="Generate sample synthetic CCTV crops for demonstration")
    parser.add_argument("--no-zip", action="store_true", help="Skip creating zip archive")

    args = parser.parse_args()

    if args.create_sample or not os.path.exists(args.input):
        if not os.path.exists(args.input):
            print(f"Directory '{args.input}' not found. Generating sample crops...")
        generate_sample_cctv_crops(args.input)

    process_custom_dataset(args.input, args.output, zip_output=not args.no_zip)

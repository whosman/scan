#!/usr/bin/env bash
# Download the test and training data into $HWSCAN_DATA (default ./data). About 2.2 GB. Not needed to run the app.
set -euo pipefail
D="${HWSCAN_DATA:-$(cd "$(dirname "$0")/.." && pwd)/data}"
mkdir -p "$D/smartdoc" "$D/handwriting" "$D/fonts" "$D/raw"
SD=https://github.com/jchazalon/smartdoc15-ch1-dataset/releases/download/v2.0.0
echo "SmartDoc 2015 challenge 1 (frames ~1 GB, models ~400 MB)"
curl -L -o "$D/smartdoc/frames.tar.gz" "$SD/frames.tar.gz"
curl -L -o "$D/smartdoc/models.tar.gz" "$SD/models.tar.gz"
tar -xzf "$D/smartdoc/models.tar.gz" -C "$D/smartdoc" --wildcards '02-edited/*'
tar -xzf "$D/smartdoc/frames.tar.gz" -C "$D/smartdoc" metadata.csv.gz README.md
# 1 frame in 20 (1,319 frames) is the sample used in docs/RESULTS.md
zcat "$D/smartdoc/metadata.csv.gz" | awk -F, 'NR>1 && ($9 % 20)==1 {print $8}' > "$D/smartdoc/sample.txt"
awk 'NR%2==0' "$D/smartdoc/sample.txt" > "$D/smartdoc/sample_half.txt"
tar -xzf "$D/smartdoc/frames.tar.gz" -C "$D/smartdoc" -T "$D/smartdoc/sample.txt"
echo "Handwriting test lines (test pages only, not shipped): IAM (research use) and MathWriting (CC BY-NC-SA)"
curl -L -o "$D/handwriting/iam_test.parquet" "https://huggingface.co/api/datasets/Teklia/IAM-line/parquet/default/test/0.parquet"
curl -L -o "$D/handwriting/mathwriting_test.parquet" "https://huggingface.co/api/datasets/deepcopy/MathWriting-human/parquet/default/test/0.parquet"
echo "Open-licence handwriting fonts (SIL OFL) for orientation training"
for p in caveat/Caveat%5Bwght%5D.ttf patrickhand/PatrickHand-Regular.ttf indieflower/IndieFlower-Regular.ttf \
  shadowsintolight/ShadowsIntoLight.ttf gochihand/GochiHand-Regular.ttf kalam/Kalam-Regular.ttf \
  architectsdaughter/ArchitectsDaughter-Regular.ttf reeniebeanie/ReenieBeanie.ttf nothingyoucoulddo/NothingYouCouldDo.ttf \
  coveredbyyourgrace/CoveredByYourGrace.ttf gloriahallelujah/GloriaHallelujah.ttf neucha/Neucha.ttf \
  handlee/Handlee-Regular.ttf delius/Delius-Regular.ttf sriracha/Sriracha-Regular.ttf; do
  curl -sfL -o "$D/fonts/$(basename "$p" | sed 's/%5B//;s/%5D//')" "https://github.com/google/fonts/raw/main/ofl/$p" || echo "font failed: $p"
done
python3 "$(dirname "$0")/../tools/prepare_handwriting.py"
echo "Done. Optional: put your own homework photos in $D/raw (they are never committed)."

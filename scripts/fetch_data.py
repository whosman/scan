"""Download the test and training data into $HWSCAN_DATA (default ./data). About 2.2 GB. Not needed to run the app.
Same steps as fetch_data.sh, for systems without bash (Windows)."""
import csv, gzip, os, subprocess, sys, tarfile, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.environ.get("HWSCAN_DATA", os.path.join(ROOT, "data"))
SD = "https://github.com/jchazalon/smartdoc15-ch1-dataset/releases/download/v2.0.0"
FONTS = ["caveat/Caveat%5Bwght%5D.ttf", "patrickhand/PatrickHand-Regular.ttf", "indieflower/IndieFlower-Regular.ttf",
         "shadowsintolight/ShadowsIntoLight.ttf", "gochihand/GochiHand-Regular.ttf", "kalam/Kalam-Regular.ttf",
         "architectsdaughter/ArchitectsDaughter-Regular.ttf", "reeniebeanie/ReenieBeanie.ttf",
         "nothingyoucoulddo/NothingYouCouldDo.ttf", "coveredbyyourgrace/CoveredByYourGrace.ttf",
         "gloriahallelujah/GloriaHallelujah.ttf", "neucha/Neucha.ttf", "handlee/Handlee-Regular.ttf",
         "delius/Delius-Regular.ttf", "sriracha/Sriracha-Regular.ttf"]


def get(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    print("get", url, flush=True)
    urllib.request.urlretrieve(url, dest + ".part")
    os.replace(dest + ".part", dest)


def main():
    for sub in ("smartdoc", "handwriting", "fonts", "raw"):
        os.makedirs(os.path.join(D, sub), exist_ok=True)
    sd = os.path.join(D, "smartdoc")
    get(SD + "/frames.tar.gz", os.path.join(sd, "frames.tar.gz"))
    get(SD + "/models.tar.gz", os.path.join(sd, "models.tar.gz"))
    with tarfile.open(os.path.join(sd, "models.tar.gz")) as t:
        t.extractall(sd, members=[m for m in t if m.name.lstrip("./").startswith("02-edited/")])
    with tarfile.open(os.path.join(sd, "frames.tar.gz")) as t:
        t.extractall(sd, members=[m for m in t if os.path.basename(m.name) in ("metadata.csv.gz", "README.md")])
    meta = next(os.path.join(r, "metadata.csv.gz") for r, _, f in os.walk(sd) if "metadata.csv.gz" in f)
    with gzip.open(meta, "rt") as f:
        rows = list(csv.reader(f))[1:]
    names = [r[7] for r in rows if int(r[8]) % 20 == 1]
    with open(os.path.join(sd, "sample.txt"), "w", newline="\n") as f:
        f.write("\n".join(names) + "\n")
    with open(os.path.join(sd, "sample_half.txt"), "w", newline="\n") as f:
        f.write("\n".join(n for i, n in enumerate(names, 1) if i % 2 == 0) + "\n")
    want = set(names)
    with tarfile.open(os.path.join(sd, "frames.tar.gz")) as t:
        t.extractall(sd, members=[m for m in t if m.name in want or m.name.lstrip("./") in want])
    hw = os.path.join(D, "handwriting")
    get("https://huggingface.co/api/datasets/Teklia/IAM-line/parquet/default/test/0.parquet", os.path.join(hw, "iam_test.parquet"))
    get("https://huggingface.co/api/datasets/deepcopy/MathWriting-human/parquet/default/test/0.parquet", os.path.join(hw, "mathwriting_test.parquet"))
    for p in FONTS:
        try:
            get("https://github.com/google/fonts/raw/main/ofl/" + p, os.path.join(D, "fonts", os.path.basename(p).replace("%5B", "").replace("%5D", "")))
        except Exception as e:
            print("font failed:", p, e)
    subprocess.check_call([sys.executable, os.path.join(ROOT, "tools", "prepare_handwriting.py")])
    print("Done. Optional: put your own homework photos in", os.path.join(D, "raw"), "(never committed).")


if __name__ == "__main__":
    main()

from pathlib import Path

Path(__file__).with_suffix(".executed").write_text("build backend imported")
raise RuntimeError("The local experiment must never load target build backends")

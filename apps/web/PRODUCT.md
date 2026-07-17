# PRODUCT.md — embedded

**What it is.** A local-first, datasheet-grounded workflow tool that carries an embedded hardware prototype end-to-end through seven phases: Scope → Architecture → Components → Electrical → Firmware → Bring-up → Optimize. Every number it shows is cited to a datasheet page or a calculator run; a missing number is left honestly missing rather than guessed.

**Who uses it.** A working embedded/EE engineer building things like a coin-cell smart-home sensor, a LoRa mesh node, or rocket avionics — at a bench, often at night, cross-referencing PDFs. They want to spend their attention on *design decisions*, not on data-filing or logistics.

**Register.** Product (a dense professional tool; design serves the task). See `DESIGN.md` for the visual language ("Bench").

**The core loop.** Sketch an architecture of blocks → bind real parts from an owned library → the electrical truth (power budget, battery life, rule findings) follows automatically from the bound datasheets, with provenance on every figure.

**Principles.**
- Grounding over guessing: an uncited gap is honest; a confidently cited wrong number is not.
- The user plans; the tool handles logistics (ingest, filing, extraction) quietly in the background.
- Local and yours: all data lives on the user's machine.

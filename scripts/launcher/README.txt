OpenWhispr — Intel NPU Build
============================

FIRST-TIME SETUP
----------------

1. Extract this zip into a user-writable folder.
   Recommended: %LOCALAPPDATA%\Programs\OpenWhispr\
   (Paste that path into File Explorer's address bar to navigate there.)

   Avoid C:\Program Files\ — extracting there needs admin rights, and
   OpenVINO needs to write its compiled-NPU-graph cache next to the
   model files at runtime, which Program Files won't allow.

2. Double-click "Setup-OpenWhispr.bat" (in this folder).

   This runs once and:
     - Removes Mark-of-the-Web from the extracted files (otherwise
       Windows SmartScreen blocks the unsigned binaries).
     - Adds an OpenWhispr shortcut to your Start Menu, so you can
       launch via Windows search by typing "OpenWhispr".
     - Launches OpenWhispr.


SUBSEQUENT LAUNCHES
-------------------

Use the Start Menu shortcut, or double-click OpenWhispr.exe directly.


IF SETUP-OPENWHISPR.BAT FAILS
-----------------------------

Some corporate machines block batch files. Fallback: open PowerShell
in the install folder and run:

  Get-ChildItem -Recurse | Unblock-File

Then double-click OpenWhispr.exe directly.

If you still see "Windows protected your PC" / SmartScreen on launch,
click "More info" -> "Run anyway".

If "Run anyway" isn't shown (some IT policies hide it), ask IT to
whitelist OpenWhispr.exe in the install folder.


WHAT'S BUNDLED
--------------

This is a self-contained build — nothing else needs to be installed:

  resources\python-runtime\   Python 3.12 + OpenVINO 2025.4.1 + deps
  resources\npu-models\       Pre-converted whisper-base model
  resources\bin\              Native helper binaries

You do NOT need: Python, pip, PyPI access, HuggingFace access,
admin rights, or a code-signing cert.

You DO need: an Intel NPU (Core Ultra 1xx/2xx, Arrow Lake, or
similar). Quick check in PowerShell:

  Get-PnpDevice | Where-Object FriendlyName -like "*Intel(R) AI Boost*"

If that returns nothing, your CPU has no NPU and this build won't
help — use the upstream OpenWhispr build with CPU/Whisper.cpp instead.

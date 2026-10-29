@echo off
cd /d "%~dp0python"
start "" ".venv\Scripts\pythonw.exe" -m extract_moon.cli explorer

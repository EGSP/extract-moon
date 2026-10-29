# Данные

Содержимое `runs/` и `replays/` не коммитится (см. `.gitignore`), хранится только структура.
[journal.md](journal.md) — журнал запусков, он в git.

- `runs/<запуск>/` — один запуск обучения: `run.json` (паспорт: коммит, правила, родитель, заметка), `config.json`, `metrics.csv` (метрики по обновлениям),
  `metrics.png` (графики, `extract-moon plot`), `checkpoints/model_XXXXXX.pt` и `checkpoints/latest.pt`,
  `replays/uXXXXXX_seedN.jsonl.gz` — матчи на постоянной карте по ходу обучения.
- `replays/` — записанные матчи `*.jsonl.gz` (формат описан в `godot/README.md`), GIF и снимки экрана.

Хранить все матчи не нужно: любой чекпойнт можно прогнать на нужной карте командой
`extract-moon record --checkpoint <запуск или путь> --seed <карта>`.

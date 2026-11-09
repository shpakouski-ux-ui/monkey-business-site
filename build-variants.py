#!/usr/bin/env python3
"""Собирает три версии первого экрана из одного index.html: a/, c/, e/.

Код и стили общие (лежат в корне), версия отличается только атрибутом data-layout.
Запускать после каждой правки index.html:  python3 build-variants.py
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).parent
LAYOUTS = {
    'a': 'Monkey Business · A',
    'c': 'Monkey Business · C',
    'e': 'Monkey Business · E',
}

src = (ROOT / 'index.html').read_text(encoding='utf-8')

for key, title in LAYOUTS.items():
    html = src.replace('<html lang="en" data-theme="light">', f'<html lang="en" data-theme="light" data-layout="{key}">', 1)
    html = re.sub(r'<title>.*?</title>', f'<title>{title}</title>', html, count=1)
    # общие файлы лежат на уровень выше
    for name in ('style.css', 'main.js', 'cases.js'):
        html = html.replace(f'href="{name}"', f'href="../{name}"').replace(f'src="{name}"', f'src="../{name}"')
    out = ROOT / key
    out.mkdir(exist_ok=True)
    (out / 'index.html').write_text(html, encoding='utf-8')
    print(f'{key}/index.html')

    # Версия для публикации ссылкой (claude.ai Artifact): хостинг сам оборачивает страницу в <html><head><body>,
    # поэтому оставляем только содержимое, а раскладку ставим на <html> скриптом до загрузки стилей
    page = re.search(r'<head>(.*?)</head>\s*<body>(.*?)</body>', src, re.S)
    head, body = page.group(1), page.group(2)
    head = re.sub(r'\s*<meta charset[^>]*>|\s*<meta name="viewport"[^>]*>', '', head)
    head = re.sub(r'<title>.*?</title>', f'<title>{title}</title>', head, count=1)
    boot = f'<script>document.documentElement.dataset.layout = "{key}"; document.documentElement.dataset.theme = "light";</script>'
    art = ROOT / 'artifact'
    art.mkdir(exist_ok=True)
    (art / f'{key}.html').write_text(f'{head.strip()}\n  {boot}\n{body.strip()}\n', encoding='utf-8')
    print(f'artifact/{key}.html')

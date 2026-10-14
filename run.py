"""
Точка входа приложения «Орбитальный пост наблюдения».

Запуск
------
    python run.py

После запуска приложение доступно по адресу http://127.0.0.1:8000.
Адрес и порт можно изменить через переменные окружения
``DASHBOARD_HOST`` и ``DASHBOARD_PORT``, заданные в файле `.env`
в корне проекта либо в самой среде.

Описание работы приложения приведено в файле README.md.
"""

from __future__ import annotations

import uvicorn

from backend import settings


def main() -> None:
    """
    Запускает веб-сервер и блокирует текущий процесс до его остановки.

    Notes
    -----
    Параметр ``reload`` намеренно не включается: разработка ведётся
    с перезапуском приложения вручную, а автоматическая перезагрузка
    приводит к лишним обращениям к внешним источникам данных
    во время разработки интерфейса.
    """
    print('=' * 68)
    print('  Орбитальный пост наблюдения')
    print('=' * 68)
    print(f'  Адрес:      http://{settings.HOST}:{settings.PORT}')
    print(f'  Документация: http://{settings.HOST}:{settings.PORT}/docs')
    print(f'  Кэш:        {settings.CACHE_DIRECTORY}')
    print('=' * 68)
    print('  Остановка: Ctrl+C')
    print()

    uvicorn.run(
        'backend.main:app',
        host=settings.HOST,
        port=settings.PORT,
        reload=False,
        log_level='info',
    )


if __name__ == '__main__':
    main()

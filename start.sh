#!/usr/bin/env bash
# Запуск дашборда одной командой: ./start.sh
set -e
cd "$(dirname "$0")"

PORT="${DASHBOARD_PORT:-8000}"
URL="http://127.0.0.1:${PORT}"

echo ""
echo "============================================"
echo "  Орбитальный пост наблюдения"
echo "============================================"
echo ""

if [ ! -d ".venv" ]; then
    echo "Окружение не найдено, создаю..."
    python3 -m venv .venv
    # shellcheck disable=SC1091
    source .venv/bin/activate
    python3 -m pip install --upgrade pip
    python3 -m pip install -r requirements.txt
    echo ""
    echo "Готово."
else
    # shellcheck disable=SC1091
    source .venv/bin/activate
fi

echo "Запускаю сервер..."
echo "Браузер откроется сам, как только сервер будет готов."
echo "Чтобы остановить - нажми Ctrl+C."
echo ""

# Браузер открывается только после того, как сервер начал отвечать.
# Раньше он открывался сразу и показывал ошибку подключения.
(
    for _ in $(seq 1 60); do
        if curl -sf -o /dev/null "$URL"; then
            sleep 0.3
            if command -v open >/dev/null 2>&1; then open "$URL"
            elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
            fi
            break
        fi
        printf "."
        sleep 1
    done
    echo ""
) &

python3 run.py

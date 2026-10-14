@echo off
chcp 65001 > nul
cd /d "%~dp0"

rem Этот файл умеет два дела. Основной запуск выполняется без
rem аргументов. Внутренний режим ожидания вызывается меткой,
rem переданной аргументом: cmd /c call start.bat :wait
rem Метка передаётся именно аргументом, потому что обратиться к
rem ней из другой команды нельзя: cmd попытался бы открыть файл с
rem именем метки и завершился бы с ошибкой.
if /i "%~1"==":wait" goto :wait

title Орбитальный пост наблюдения

echo.
echo ============================================
echo   Орбитальный пост наблюдения
echo ============================================
echo.

if not exist ".venv" (
    echo Окружение не найдено, создаю...
    python -m venv .venv
    if errorlevel 1 goto :nopython
    call .venv\Scripts\activate.bat
    python -m pip install --upgrade pip
    python -m pip install -r requirements.txt
    echo.
    echo Готово.
) else (
    call .venv\Scripts\activate.bat
)

rem Окружение могло остаться от другого компьютера: его конфиг
rem ссылается на несуществующий интерпретатор, и python молча
rem умирает при первом же запуске. Работоспособность окружения
rem проверяется явным запуском перед стартом сервера.
python -c "print(1)" >nul 2>&1

if errorlevel 1 (
    echo Окружение повреждено, пересоздаю...

    rmdir /s /q .venv

    python -m venv .venv

    if errorlevel 1 goto :nopython

    call .venv\Scripts\activate.bat

    python -m pip install --upgrade pip

    python -m pip install -r requirements.txt
)

echo Запускаю сервер...
echo Браузер откроется сам, как только сервер будет готов.
echo Чтобы остановить - нажми Ctrl+C в этом окне.
echo.

rem Браузер открывает отдельный процесс: он ждёт готовности
rem сервера и только потом открывает страницу. Отдельный процесс
rem нужен потому, что python run.py ниже занимает это окно до
rem самой остановки сервера, и код ожидания не выполнился бы.
start "Орбитальный пост" /min "%~f0" :wait

python run.py
goto :end

:wait
rem Ждёт ответа сервера на порту 8000 и открывает браузер.
rem Проверка идёт настоящим подключением: одно лишь существование
rem порта не гарантирует, что отвечает именно наш сервер.
setlocal enabledelayedexpansion
set /a waited=0
:waitloop
set /a waited+=1
>nul 2>&1 ping -n 1 127.0.0.1 > nul
>nul 2>&1 powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient('127.0.0.1',8000);$c.Close();exit 0}catch{exit 1}"
if not errorlevel 1 goto :ready
if !waited! geq 60 (
    echo Сервер не отвечает дольше минуты.
    echo Возможно, порт занят другим приложением.
    echo Закройте лишние программы и запустите ещё раз.
    pause
    exit /b 1
)
set /p "=  Жду сервер" <nul
set /p "=." <nul
goto :waitloop
:ready
echo.
echo Сервер готов, открываю браузер...
start "" "http://127.0.0.1:8000"
exit /b 0

:nopython
echo.
echo Не найден Python. Установи Python 3.10 или новее:
echo https://www.python.org/downloads/
echo И не забудь при установке поставить галочку "Add Python to PATH".
echo.
pause

:end

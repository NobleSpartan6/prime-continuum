@echo off
if "%PRIME_CONTINUIM_BROWSER_EXECUTABLE%"=="" goto unavailable
if "%PRIME_CONTINUIM_BROWSER_BRIDGE%"=="" goto unavailable
"%PRIME_CONTINUIM_BROWSER_EXECUTABLE%" "%PRIME_CONTINUIM_BROWSER_BRIDGE%" %*
exit /b %errorlevel%
:unavailable
echo Verified browser execution is unavailable for this resident session. 1>&2
exit /b 1

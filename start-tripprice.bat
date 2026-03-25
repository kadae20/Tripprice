@echo off
:: Tripprice 편집국 자동 시작
:: 윈도우 로그인 시 PM2로 24/7 스케줄러 복원
cd /d "C:\Users\박건호\.claude\tripprice"
call "C:\Users\박건호\AppData\Roaming\npm\pm2.cmd" resurrect

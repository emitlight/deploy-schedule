@echo off
rem Deploy the Cloudflare Worker: tests, login check, deploy, optional internal server update
chcp 65001 >nul
cd /d "%~dp0"
node tools\deploy.mjs

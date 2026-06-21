# 开发
nohup npm run dev > logs/dev.log 2>&1 < /dev/null & echo $!


推荐方案 2：pm2，简单好用

npm install -g pm2
cd /root/ai-proxy/codex-proxy
npm run build
pm2 start npm --name codex-proxy -- start
pm2 save
pm2 startup

查看：
pm2 status
pm2 logs codex-proxy
pm2 restart codex-proxy
pm2 stop codex-proxy


#临时
cd /root/ai-proxy/codex-proxy
mkdir -p logs
npm run build
setsid bash -lc 'exec npm start >> logs/start.log 2>&1' >/dev/null 2>&1 < /dev/null &
echo $!



curl http://localhost:8080/v1/chat/completions \
-H "Content-Type: application/json" \
-H "Authorization: Bearer pwd" \
-d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello!"}],"stream":true}'


# ReadFrog Raycast

在 Raycast Extensions → Add Script Directory 添加此目录，保留启动、停止、状态三个命令。

`config.sh` 集中配置 Node 路径和项目目录，默认从当前脚本目录定位仓库根目录。
移动整个目录后，Raycast 中重新选择脚本目录；再运行
`node install-autostart.mjs` 更新 macOS 登录自启路径。
如果修改了 config.sh 中的项目或 Node 路径，先加载该配置再运行安装脚本：

```sh
source ./config.sh
"$READFROG_NODE" ./install-autostart.mjs
```

登录自启文件必须使用绝对路径，移动项目后需要重新安装。停止只影响当前会话，不清除登录或预算。

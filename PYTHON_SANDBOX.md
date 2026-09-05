# 本地 Python 项目沙箱

现在可以用 npm 的 `microsandbox` 在本机 microVM 中运行 Python 项目。

## 启动

```bash
npm install
npm start
```

`npm start` 会启动原来的 Chat 服务，并在 `3001` 端口增加一个代理层。浏览器访问 `http://localhost:3001` 即可。

首次执行 Python 项目时，microsandbox 可能需要拉取 `python` OCI 镜像，并且本机需要满足它的虚拟化要求。

## Chat 中运行项目

模型现在额外拥有 `run_python_project` 工具。当用户明确要求运行、测试或检查本地 Python 项目时，模型可以调用它：

- `projectPath`：本机 Python 项目目录的绝对路径
- `command`：项目目录内的命令，例如 `python main.py`、`pytest`
- `installDependencies`：是否根据 `requirements.txt` 安装依赖
- `timeoutMs`：执行超时，默认 120 秒，最大 600 秒

项目目录会以读写 bind mount 的方式挂载到 sandbox 的 `/workspace`，所以程序产生的文件变化会回写到本机项目目录；Python 代码本身和命令执行在 microsandbox microVM 内完成。

也可以直接调用：

```bash
curl -X POST http://localhost:3001/api/python/run \
  -H 'content-type: application/json' \
  -d '{"projectPath":"/absolute/path/to/project","command":"python main.py"}'
```

## 安全边界

`projectPath` 必须是绝对路径，并且目录会被完整读写挂载到 sandbox。因此只应把需要运行的项目目录交给它，不要把包含 SSH 密钥、凭据或其他敏感文件的父目录作为项目目录。

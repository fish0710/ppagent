# ppagent

为本地部署模型设计的 coding agent harness。

> **在线介绍页：** [https://fish0710.github.io/ppagent/](https://fish0710.github.io/ppagent/)

云端 agent 往往假设算力与并发资源充足，而本地模型需要与 agent 共享同一台机器的内存、GPU 和进程资源。ppagent 从这些约束出发，探索面向本地模型的上下文压缩、子 agent 准入、系统级隔离和资源感知执行。

## 当前状态

项目正在公开开发中：

- M0：工程骨架、依赖方向规则与 CI 已完成
- M1：核心类型契约已完成
- M2：模型调用层与测试 provider 正在进行
- 其余里程碑见[在线介绍页](https://fish0710.github.io/ppagent/#roadmap)

目前还没有可安装的发行版本，也还不能作为完整 agent 运行。

## 本地开发

需要 Node.js 22。

```bash
npm ci
npm run build
npm run depcruise
npm test
```

## 设计文档

- [Agent 开发设计书](docs/agent-%E5%BC%80%E5%8F%91%E8%AE%BE%E8%AE%A1%E4%B9%A6.md)

## License

ISC

# Hermes Agent Integration

[Hermes Agent](https://hermes-agent.nousresearch.com/)（Nous Research）集成的研究占位目录。

状态：待调研。**实现前必须在实机核实下列内容**，核实结果与公开文档不符时以实机为准（见 [新增 Integration 指南](../../../docs/adding-an-integration.md) 第 1 节）：

- `hermes --version` 的输出格式，以及要支持的最低版本；
- `hermes config path` / `hermes config env-path` 返回的真实路径；
- `config.yaml` 里自定义 OpenAI 兼容 provider 的确切字段名（公开文档描述为 `providers.<id>.{base_url, api_key, models[]}`）；
- `${VAR}` 插值是否对**进程环境变量**生效，而不仅仅对 `~/.hermes/.env` 生效——这决定凭据能否只经启动器注入；
- 选择模型写在哪个配置键上；
- 改完配置是否需要重启，以及是否存在热加载。

## 已确定的设计约束

- **不写 `~/.hermes/.env`。** Hermes 的取值优先级是 环境变量 → `.env` → 配置默认值，因此凭据只在 `apexnova run hermes` 启动的进程环境里存在，配置文件里只放 `${APEXNOVA_API_KEY}` 引用。
- YAML 编辑必须保留注释与用户的其他设置。
- 核实完成前，本 Integration 不得声明任何 capability 或权限（Manifest Schema 对 `research`/`planned` 状态强制这一点）。

# KnowledgeHub 维护说明

## 开发与检查

使用 `.nvmrc` 指定的 Node.js 24 LTS 和 Yarn 1.22.22。根目录、`server`、`frontend`、`collector` 的 `yarn.lock` 均应提交；依赖安装使用 `yarn install --frozen-lockfile`。

`Tests` 和 `Lint` 工作流在 PR、推送到 `main` 和手动触发时运行。检查不按文件路径跳过，以便主分支保护始终收到结果。测试工作流安装四个目录的依赖，包括组件测试使用的前端依赖，并在临时 runner 内初始化 Prisma 数据库。

本地检查：

```sh
yarn lint:ci
yarn test --ci --runInBand
```

全量测试可能初始化数据库和生成文件，建议使用独立开发环境；不要指向正在使用的实例数据。环境文件使用 `.env` 或 `.env.*`，只提交不含凭据的 `.env.example`。

## 主分支保护

仓库设置不会随 Git 提交自动生效。先将工作流推送到 GitHub 并运行成功，再在仓库 Settings → Rules → Rulesets 中导入 [主分支规则](./.github/rulesets/main.json)。规则要求通过 PR 合入、禁止删除和强制推送，并要求以下检查通过：

- `tests`
- `lint-server`
- `lint-frontend`
- `lint-collector`

允许零个审批，便于单人维护；PR 仍需通过全部检查。团队扩大后可提高所需审批数。

## 镜像与版本发布

推送到 `main` 时发布 `ghcr.io/loutaiyue/knowledgehub:latest`，同时保留分支和提交 SHA 标签。正式发布的镜像按 Release 标签生成，例如 `knowledgehub-v1.0.0` 对应 `knowledgehub-v1.0.0`、`1.0.0`、`1.0`。镜像仅发布到当前仓库的 GHCR，使用 `GITHUB_TOKEN`，不需要 Docker Hub 凭据。

现有本地 `knowledgehub-v1.0.0` 标签指向原始功能提交 `c1d0214e`。若要发布这一原始版本，先核对 `git show knowledgehub-v1.0.0`，再显式推送该标签，并在 GitHub Releases 中创建对应版本。后续维护修复使用新版本标签，例如 `knowledgehub-v1.0.1`；保留已确定版本的标签指向。

```sh
git push origin refs/tags/knowledgehub-v1.0.0
# 维护修复提交完成且 CI 通过后，再按版本计划创建新标签：
git tag -a knowledgehub-v1.0.1 -m "KnowledgeHub 1.0.1"
git push origin refs/tags/knowledgehub-v1.0.1
```

推送标签与发布 GitHub Release 是两个独立步骤；发布 Release 会触发版本镜像构建。

## 上游补丁

基础版本为 AnythingLLM `f31b5adf`，保留上游提交历史与 MIT 版权声明。同步上游时先检查差异、依赖和回归测试，再按需移植；不要直接重写已发布历史。

本次移植 [上游提交 1626d971c73d70a68602a662e3baf52e160c62ff](https://github.com/Mintplex-Labs/anything-llm/commit/1626d971c73d70a68602a662e3baf52e160c62ff) 中适用于当前版本的 PDF/DOCX 图片下载防护：

- 共享图片加载器检查目标地址、DNS 解析和重定向，限制请求时长和响应大小，并校验实际图片格式。
- PDF 渲染前将允许的图片转换为内嵌数据，移除无法加载的图片。
- DOCX 使用相同加载器，保留图片尺寸回退。
- 同步上游的 13 个回归测试。当前基线没有该补丁涉及的新版 PPTX 下载模块，因此没有引入该模块或其额外依赖。

这次是选择性移植，上游其余更新仍需逐项评估。

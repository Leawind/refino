# @refino/cli

`refino` 引擎的命令行接口：对 Constraint Refinement Graph 的查询、校验与节点读写、本地 Web 界面服务（`refino web`），以及面向 agent 的自文档（`refino guide`）。

```txt
Usage: refino [options] [command]

Parse, validate and query a Constraint Refinement Graph stored in .refino/.

Options:
  -V, --version              output the version number
  --root <dir>               project root directory containing .refino/ (default: current working directory)
  -h, --help                 display help for command

Commands:
  validate                   build the graph and report all validation issues
  list [options]             list all nodes (id, type, summary)
  show <ids...>              print the full record of one or more nodes
  grounds <ids...>           direct grounds of one or more nodes
  ancestors <ids...>         all nodes reachable by recursively following grounds
  dependents <ids...>        constraints potentially affected if these nodes change
  new                        create a new node file in .refino/
  update [options] <id>      update fields of an existing node; unspecified fields keep their current value
  delete [options] <ids...>  delete one or more nodes; refuses while other nodes ground on the target
  web [options]              start the web UI server
  init                       create the .refino/ directory skeleton (pure scaffolding)
  guide                      print the agent-facing usage guide (concepts, conventions, caveats)
  help [command]             display help for command
```

Run `refino guide` for the agent-facing usage guide (concepts, conventions, caveats).

## 了解更多

- 包内设计细节：[DESIGN.md](./DESIGN.md)
- Web 界面与 API 契约：[docs/design.md](../../docs/design.md)

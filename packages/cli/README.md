# @refino/cli

`refino` 引擎的命令行接口：对 Constraint Refinement Graph 的查询、校验与节点读写，以及面向 agent 的通用接入命令（上下文渲染、授权签发、自文档）与本地 Web 界面服务（`refino web`）。

```txt
Usage: refino [options] [command]

Parse, validate and query a Constraint Refinement Graph stored in .refino/.

Options:
  -V, --version              output the version number
  --root <dir>               project root directory containing .refino/ (default:
                             "/home/leawind/Workspace/github.com/Leawind/refino-worktrees/examples")
  --json                     emit machine-readable JSON on stdout (default: false)
  --authorization <path>     path to an orchestrator-signed authorization document (overrides workspace state)
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
  context [options]          render the current authorization context (the task's opening context)
  search [options] [query]   paginated search over id prefixes and summaries
  pending [options]          nodes changed since a git baseline and their downstream pending-review constraints
  auth                       show, apply or reset the workspace's signed authorization
  guide                      print the full working protocol (written for models)
  skill [options]            print the SKILL.md content with install guidance
  help [command]             display help for command
```

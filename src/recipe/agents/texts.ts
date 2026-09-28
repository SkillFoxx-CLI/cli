import type { AgentId, Lang } from './types'

type Texts = {
  terminal: string
  runInTerminal: string
  runInProject: string
  runInChat: string
  addToFile: string
  orFile: string
  fileMerge: (key: string) => string
  fileMergeToml: string
  skillsCliNote: string
  gitFallback: (sha: string) => string
  gitNote: string
  installCli: string
  pipNote: (pkg: string) => string
  rulesAppend: string
  rulesAppendNote: string
  rulesMdc: string
  secretPlaceholder: (name: string) => string
  valuePlaceholder: (name: string) => string
  systemVars: Record<string, string>
  agentNote: Partial<Record<AgentId, string>>
  mcpNote: Partial<Record<AgentId, string>>
  aiNote: string
  noRecipe: string
}

export const TEXTS: Record<Lang, Texts> = {
  ru: {
    terminal: 'Терминал',
    runInTerminal: 'Выполните в терминале',
    runInProject: 'Выполните в терминале в папке проекта',
    runInChat: 'Выполните по очереди в чате Claude Code',
    addToFile: 'Добавьте в файл',
    orFile: 'Или добавьте в файл',
    fileMerge: (key) => `Если файл уже есть, добавьте сервер внутрь ключа ${key}.`,
    fileMergeToml: 'Если файл уже есть, допишите блок в конец.',
    skillsCliNote: 'Утилита skills ставит текущую версию из репозитория. Чтобы скилл работал во всех проектах, добавьте флаг -g.',
    gitFallback: (sha) => `Без сторонних утилит, из коммита ${sha}`,
    gitNote: 'Команды для macOS и Linux, на Windows выполните их в Git Bash.',
    installCli: 'Установите утилиту',
    pipNote: (pkg) => `Без pipx подойдет pip install ${pkg}.`,
    rulesAppend: 'Добавьте правила в проект',
    rulesAppendNote: 'Если AGENTS.md уже есть, правила допишутся в конец файла.',
    rulesMdc: 'Скачайте правило в папку проекта',
    secretPlaceholder: (name) => `<ваш ${name}>`,
    valuePlaceholder: (name) => `<значение ${name}>`,
    systemVars: { HOME: '<домашняя папка>', PWD: '<папка проекта>', USER: '<имя пользователя>', TMPDIR: '<временная папка>' },
    agentNote: { devin: 'Бывший Windsurf.', 'zoo-code': 'Форк Roo Code, папки .roo те же.' },
    mcpNote: {
      cursor: 'Для одного проекта тот же блок кладут в .cursor/mcp.json.',
      devin: 'В легаси Cascade конфиг MCP лежит в ~/.codeium/windsurf/mcp_config.json.',
      cline: 'Файл настроек открывается в Cline: вкладка MCP Servers, кнопка Configure MCP Servers.',
    },
    aiNote: 'Собрано автоматически, проверьте перед установкой.',
    noRecipe: 'Для записи нет автоматической установки. Используйте способы из get_entry и сначала посмотрите репозиторий.',
  },
  en: {
    terminal: 'Terminal',
    runInTerminal: 'Run in a terminal',
    runInProject: 'Run in a terminal in the project folder',
    runInChat: 'Run one by one in the Claude Code chat',
    addToFile: 'Add to the file',
    orFile: 'Or add to the file',
    fileMerge: (key) => `If the file already exists, add the server inside the ${key} key.`,
    fileMergeToml: 'If the file already exists, append the block to the end.',
    skillsCliNote: 'The skills tool installs the current version from the repository. Add the -g flag to use the skill in every project.',
    gitFallback: (sha) => `Without third-party tools, from commit ${sha}`,
    gitNote: 'Commands for macOS and Linux, on Windows run them in Git Bash.',
    installCli: 'Install the tool',
    pipNote: (pkg) => `Without pipx, pip install ${pkg} works too.`,
    rulesAppend: 'Add the rules to the project',
    rulesAppendNote: 'If AGENTS.md already exists, the rules are appended to the end.',
    rulesMdc: 'Download the rule into the project',
    secretPlaceholder: (name) => `<your ${name}>`,
    valuePlaceholder: (name) => `<${name} value>`,
    systemVars: { HOME: '<home folder>', PWD: '<project folder>', USER: '<user name>', TMPDIR: '<temp folder>' },
    agentNote: { devin: 'Formerly Windsurf.', 'zoo-code': 'A fork of Roo Code, same .roo folders.' },
    mcpNote: {
      cursor: 'For a single project, put the same block into .cursor/mcp.json.',
      devin: 'Legacy Cascade keeps the MCP config in ~/.codeium/windsurf/mcp_config.json.',
      cline: 'Open the settings file in Cline: MCP Servers tab, Configure MCP Servers.',
    },
    aiNote: 'Assembled automatically, review before installing.',
    noRecipe: 'No automatic install for this entry. Use the install methods from get_entry and review the repository first.',
  },
}

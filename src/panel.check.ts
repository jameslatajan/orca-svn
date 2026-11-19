// `orca plugin check` renders the panel once per scenario; with no focused workspace the worker
// answers the no-workspace state. `demo` feeds a realistic working copy (used for store screenshots).
import { defineCheck } from 'orca/testing'
import type { SvnState } from './protocol'

const demo: SvnState = {
  status: 'ok',
  workspace: 'HR Portal',
  info: {
    url: 'https://svn.example.com/repos/hr/trunk/portal',
    relativeUrl: '^/trunk/portal',
    root: '/work/hr',
    revision: 4182,
    lastChangedRevision: 4180,
    lastAuthor: 'maria'
  },
  behind: { head: 4187 },
  files: [
    { path: 'app/Models/LeaveRequest.php', status: 'conflicted' },
    { path: 'app/Controllers/Leave.php', status: 'modified' },
    { path: 'app/Views/leave/form.php', status: 'modified' },
    { path: 'app/Config/Routes.php', status: 'modified' },
    { path: 'public/js/leave-calendar.js', status: 'added' },
    { path: 'app/Libraries/OldExport.php', status: 'deleted' },
    { path: 'docs/leave-policy.md', status: 'unversioned' },
    { path: 'tests/LeaveTest.php', status: 'unversioned' }
  ]
}

export default defineCheck({
  fresh: {},
  demo: {
    requests: { 'svn.state': demo },
    persisted: { plugin: { commitMessage: 'Leave: show remaining balance on the request form' } }
  }
})

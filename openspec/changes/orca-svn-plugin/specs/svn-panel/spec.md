## ADDED Requirements

### Requirement: Detect working copy
The panel SHALL show SVN state only when the focused local workspace is inside an SVN working copy, and SHALL show a distinct message for: no workspace, remote workspace, not a working copy, and `svn` not installed.

#### Scenario: Not a working copy
- **WHEN** the focused workspace folder is not under SVN
- **THEN** the panel shows "This folder is not an SVN working copy"

#### Scenario: svn missing
- **WHEN** running `svn` fails with ENOENT
- **THEN** the panel explains that the svn command-line client must be installed and on PATH

### Requirement: Show working copy info and changes
The panel SHALL show the repository URL, the working copy revision, and every changed path from `svn status`, grouped as Conflicted, Modified, Added, Deleted, Missing and Unversioned, with counts.

#### Scenario: Mixed changes
- **WHEN** the working copy has one modified file, one added file and one unversioned file
- **THEN** the panel shows them under Modified (1), Added (1) and Unversioned (1)

#### Scenario: Clean working copy
- **WHEN** `svn status` reports no changes
- **THEN** the panel shows "No local changes" and the revision

### Requirement: Commit selected files
The panel SHALL let the user check files, enter a message, and commit only the checked files. Commit SHALL be disabled when the message is empty or no file is checked. On success it SHALL show the new revision; on failure the mapped error message.

#### Scenario: Successful commit
- **WHEN** the user checks `a.txt`, enters "Fix typo" and presses Commit
- **THEN** the plugin runs a non-interactive `svn commit` of `a.txt` only with that message and shows "Committed revision N"

#### Scenario: Out of date
- **WHEN** the server rejects the commit because the file is out of date
- **THEN** the panel shows "Out of date — run Update first" and keeps the message text

#### Scenario: Unversioned file checked
- **WHEN** an unversioned file is checked for commit
- **THEN** the plugin runs `svn add` on it before committing

### Requirement: Update
The plugin SHALL run `svn update` on the working copy root from the panel button and the palette, then show the resulting revision and list any conflicted paths.

#### Scenario: Update with conflict
- **WHEN** update leaves `b.txt` conflicted
- **THEN** the panel shows `b.txt` under Conflicted with a Resolve action

### Requirement: Per-file actions
The panel SHALL offer Revert (with a confirm step) for versioned changes, Add for unversioned files, Resolve for conflicted files, and Diff, which opens `svn diff <file>` in a new terminal.

#### Scenario: Revert needs confirmation
- **WHEN** the user presses Revert on `a.txt`
- **THEN** nothing is reverted until the user presses "Confirm revert"

### Requirement: Safe execution
Every `svn` call SHALL use `--non-interactive`, SHALL be run without a shell, and SHALL only pass paths inside the working copy root. Authentication failures SHALL show a message telling the user to run an svn command once in a terminal to save credentials.

#### Scenario: Path outside working copy
- **WHEN** a request names `../other/file.txt`
- **THEN** the worker refuses it and runs nothing

### Requirement: Refresh
The panel SHALL reload on workspace focus change, on the Refresh button and palette command, after each plugin action, and (debounced) when files change outside `.svn/`.

#### Scenario: External edit
- **WHEN** a file in the working copy is saved in the editor
- **THEN** the panel shows it as Modified within about one second

on parseWhenOrDate(str)
  try
    if str is "" or str is missing value then return missing value
    set lower to str as string
    if lower is "today" then
      return current date
    else if lower is "tomorrow" then
      return (current date) + 1 * days
    end if
    set AppleScript's text item delimiters to "-"
    set parts to text items of str
    set AppleScript's text item delimiters to ""
    if (count of parts) is 3 then
      set d to current date
      set day of d to 1
      set year of d to (item 1 of parts as integer)
      set month of d to (item 2 of parts as integer)
      set day of d to (item 3 of parts as integer)
      set hours of d to 0
      set minutes of d to 0
      set seconds of d to 0
      return d
    end if
    return missing value
  on error
    return missing value
  end try
end parseWhenOrDate

on run argv
  if (count of argv) is 0 then return ""
  set projTitle to item 1 of argv
  set projNotes to ""
  if (count of argv) is greater than or equal to 2 then set projNotes to item 2 of argv
  set projWhen to ""
  if (count of argv) is greater than or equal to 3 then set projWhen to item 3 of argv
  set projDeadline to ""
  if (count of argv) is greater than or equal to 4 then set projDeadline to item 4 of argv
  set projTags to ""
  if (count of argv) is greater than or equal to 5 then set projTags to item 5 of argv
  set projArea to ""
  if (count of argv) is greater than or equal to 6 then set projArea to item 6 of argv

  tell application "Things3"
    set targetArea to missing value
    if projArea is not "" then
      try
        set targetArea to area projArea
      on error
        try
          set targetArea to area id projArea
        end try
      end try
    end if
    if targetArea is not missing value then
      set newProj to make new project at targetArea with properties {name:projTitle}
    else
      set newProj to make new project with properties {name:projTitle}
    end if
    if projNotes is not "" then
      set notes of newProj to projNotes
    end if
    if projTags is not "" then
      set tag names of newProj to projTags
    end if
    if projDeadline is not "" then
      set parsedDue to my parseWhenOrDate(projDeadline)
      if parsedDue is not missing value then
        set due date of newProj to parsedDue
      end if
    end if
    if projWhen is not "" then
      set parsedWhen to my parseWhenOrDate(projWhen)
      if parsedWhen is not missing value then
        schedule newProj for parsedWhen
      end if
    end if
    return id of newProj
  end tell
end run

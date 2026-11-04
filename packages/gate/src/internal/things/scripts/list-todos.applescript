on zpad(n)
  set s to n as string
  if (count of s) is 1 then return "0" & s
  return s
end zpad

on isoDate(d)
  try
    if d is missing value then return ""
    set y to year of d as string
    set m to my zpad(month of d as integer)
    set dd to my zpad(day of d as integer)
    return y & "-" & m & "-" & dd
  on error
    return ""
  end try
end isoDate

on isoDateTime(d)
  try
    if d is missing value then return ""
    set y to year of d as string
    set m to my zpad(month of d as integer)
    set dd to my zpad(day of d as integer)
    set hh to (hours of d) as integer
    set mm to (minutes of d) as integer
    if hh is 0 and mm is 0 then
      return y & "-" & m & "-" & dd
    end if
    return y & "-" & m & "-" & dd & "T" & my zpad(hh) & ":" & my zpad(mm)
  on error
    return ""
  end try
end isoDateTime

on cleanVal(v)
  try
    if v is missing value then return ""
    return v as string
  on error
    return ""
  end try
end cleanVal

on todoRow(t, fs)
  tell application "Things3"
    set theStatus to (status of t) as string
    set theTags to ""
    try
      set theTags to (tag names of t) as string
    end try
    set theArea to ""
    try
      set theArea to name of area of t
    end try
    set theProject to ""
    try
      set theProject to name of project of t
    end try
    return (id of t as string) & fs & ¬
      my cleanVal(name of t) & fs & ¬
      theStatus & fs & ¬
      my cleanVal(notes of t) & fs & ¬
      theTags & fs & ¬
      theArea & fs & ¬
      theProject & fs & ¬
      my isoDate(due date of t) & fs & ¬
      my isoDateTime(activation date of t) & fs & ¬
      my isoDate(modification date of t) & fs & ¬
      my isoDate(creation date of t)
  end tell
end todoRow

on run argv
  set listName to "Today"
  if (count of argv) is greater than or equal to 1 then
    set listName to item 1 of argv
  end if
  set rs to character id 30
  set fs to character id 31
  tell application "Things3"
    set theList to list listName
    set theTodos to to dos of theList
    set out to ""
    repeat with t in theTodos
      if out is "" then
        set out to my todoRow(t, fs)
      else
        set out to out & rs & my todoRow(t, fs)
      end if
    end repeat
    return out
  end tell
end run

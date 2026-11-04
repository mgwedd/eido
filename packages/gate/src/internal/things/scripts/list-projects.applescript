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

on projectRow(p, fs)
  tell application "Things3"
    set theArea to ""
    try
      set theArea to (name of area of p as string)
    end try
    set theStatus to (status of p) as string
    set headingNames to ""
    try
      set hs to {}
      repeat with h in headings of p
        set end of hs to (name of h as string)
      end repeat
      set AppleScript's text item delimiters to "|"
      set headingNames to hs as string
      set AppleScript's text item delimiters to ""
    end try
    set theCount to (count of to dos of p) as string
    set theTags to ""
    try
      set theTags to (tag names of p) as string
    end try
    return (id of p as string) & fs & ¬
      my cleanVal(name of p) & fs & ¬
      theArea & fs & ¬
      theStatus & fs & ¬
      headingNames & fs & ¬
      theCount & fs & ¬
      my cleanVal(notes of p) & fs & ¬
      my isoDate(due date of p) & fs & ¬
      my isoDateTime(activation date of p) & fs & ¬
      theTags
  end tell
end projectRow

on run argv
  set areaFilter to ""
  if (count of argv) is greater than or equal to 1 then
    set areaFilter to item 1 of argv
  end if
  set rs to character id 30
  set fs to character id 31
  tell application "Things3"
    set ps to projects
    set out to ""
    repeat with p in ps
      set theArea to ""
      try
        set theArea to (name of area of p as string)
      end try
      if areaFilter is "" or theArea is areaFilter then
        if out is "" then
          set out to my projectRow(p, fs)
        else
          set out to out & rs & my projectRow(p, fs)
        end if
      end if
    end repeat
    return out
  end tell
end run

module.exports = function(app) {

  // Увеличиваем лимит для загрузки фото
  var express = require('express');
  app.use('/api/homework', express.json({ limit: '50mb' }));

  app.post('/api/homework/analyze', async (req, res) => {
    try {
      const { image, childGrade } = req.body;
      
      if (!image) {
        return res.status(400).json({ error: 'No image provided' });
      }

      console.log('Photo received for analysis, grade:', childGrade);
      console.log('Image length:', image.length);

      const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: 'Ты Мудрик - дружелюбный репетитор по математике для ребёнка ' + (childGrade || 2) + ' класса. Когда ребёнок присылает фото задания, ты ОБЯЗАТЕЛЬНО: 1) Распознаёшь ВСЕ задания на фото. 2) Решаешь КАЖДОЕ задание подробно по шагам. 3) Используешь формат: 📝 Задача: (повтори условие). 📖 Решение по шагам: Шаг 1: (что делаем и почему). Шаг 2: (что делаем и почему). Шаг 3: (если нужно). ✅ Ответ: (итоговый ответ). ✏️ ЗАПИШИ В ТЕТРАДЬ: Задача: (краткое условие). Решение: 1) (действие) = (результат) (что нашли). 2) (действие) = (результат) (что нашли). Ответ: (полный ответ с единицами). 💡 Запомни: (короткое правило). В конце напиши: Теперь понятно? Если хочешь, могу объяснить любой шаг подробнее! Используй простой язык понятный ребёнку. Объясняй каждый шаг. Используй эмодзи. НИКОГДА не спрашивай а какое первое действие - сразу давай полное решение. Отвечай ТОЛЬКО на русском языке.'
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Реши все задания на этом фото домашней работы. Дай подробное решение каждого задания. Отвечай на русском языке.'
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: image,
                    detail: 'high'
                  }
                }
              ]
            }
          ],
          max_tokens: 4000,
          temperature: 0.3
        })
      });

      const data = await openaiResponse.json();
      console.log('OpenAI response status:', openaiResponse.status);

      if (data.error) {
        console.error('OpenAI error:', data.error);
        return res.status(500).json({ error: data.error.message });
      }

      var answer = 'Не удалось распознать задание. Попробуй сделать фото четче.';
      if (data.choices && data.choices[0] && data.choices[0].message) {
        answer = data.choices[0].message.content;
      }
      
      res.json({ success: true, answer: answer });
      
    } catch (error) {
      console.error('Homework analyze error:', error);
      res.status(500).json({ error: 'Ошибка при анализе фото: ' + error.message });
    }
  });

  app.get('/api/homework/test', function(req, res) {
    res.json({ 
      status: 'ok', 
      message: 'Homework route is loaded v2',
      hasOpenAIKey: !!process.env.OPENAI_API_KEY
    });
  });

};


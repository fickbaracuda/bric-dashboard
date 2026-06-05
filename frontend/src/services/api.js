import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';

export const getScoreboard = async (bulan, metric = 'kpi') => {
  const res = await axios.get(`${API_URL}/api/scoreboard/units`, {
    params: { bulan, metric }
  });
  return res.data;
};
